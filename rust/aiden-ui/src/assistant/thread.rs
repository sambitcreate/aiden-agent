//! The assistant transcript (port of `renderer/components/assistant/assistant-thread.tsx`).
//!
//! Aiden replies render as quiet, left-aligned cards — visually distinct from
//! the main chat's full-width markdown — with a muted thinking block above the
//! content. User turns mirror the main chat's right-aligned muted bubble.

use gpui::{
    div, prelude::FluentBuilder as _, px, relative, App, ElementId, InteractiveElement as _,
    IntoElement, ParentElement as _, ScrollHandle, SharedString, StatefulInteractiveElement as _,
    Styled as _, Window,
};
use gpui_component::{text::TextView, v_flex, ActiveTheme};

use crate::assistant::view_state::{AssistantMessage, AssistantRole, AssistantViewState};
use crate::chat::markdown::markdown_with_math_fallback;

/// The speaker label for the log (`You` / `Aiden`).
#[allow(dead_code)] // renderer-contract port; exercised by unit tests
pub fn speaker_label(role: AssistantRole) -> &'static str {
    match role {
        AssistantRole::User => "You",
        AssistantRole::Assistant => "Aiden",
    }
}

/// Whether the entry at `index` is the live streaming reply (the last
/// assistant message while a generation is active or settling).
pub fn is_streaming_reply(state: &AssistantViewState, index: usize) -> bool {
    (state.phase != crate::assistant::view_state::AssistantPhase::Idle || state.stream_complete)
        && index + 1 == state.messages.len()
        && state.messages[index].role == AssistantRole::Assistant
}

/// Render the scrollable transcript.
pub fn render_thread(
    state: &AssistantViewState,
    scroll: &ScrollHandle,
    window: &mut Window,
    cx: &mut App,
) -> impl IntoElement {
    let streaming = state.phase != crate::assistant::view_state::AssistantPhase::Idle;
    let rows: Vec<(AssistantMessage, bool)> = state
        .messages
        .iter()
        .cloned()
        .enumerate()
        .map(|(index, message)| (message, is_streaming_reply(state, index)))
        .collect();

    v_flex()
        .id("assistant-thread")
        .track_scroll(scroll)
        .flex_1()
        .w_full()
        .overflow_y_scroll()
        .px_3()
        .py_2()
        .gap_3()
        .children(rows.into_iter().map(|(message, live)| {
            render_message(&message, live, streaming, window, cx).into_any_element()
        }))
        .when(state.error.is_some(), |el| {
            let danger = cx.theme().danger;
            el.child(
                div()
                    .id("assistant-error")
                    .w_full()
                    .px_3()
                    .py_2()
                    .rounded_md()
                    .bg(danger.opacity(0.12))
                    .text_xs()
                    .text_color(danger)
                    .child(state.error.clone().unwrap_or_default()),
            )
        })
}

fn render_message(
    message: &AssistantMessage,
    live: bool,
    streaming: bool,
    window: &mut Window,
    cx: &mut App,
) -> gpui::AnyElement {
    match message.role {
        AssistantRole::User => {
            let muted = cx.theme().muted;
            h_user_bubble(message, muted).into_any_element()
        }
        AssistantRole::Assistant => {
            render_assistant_card(message, live, streaming, window, cx).into_any_element()
        }
    }
}

fn h_user_bubble(message: &AssistantMessage, muted: gpui::Hsla) -> impl IntoElement {
    gpui_component::h_flex()
        .id(ElementId::Name(SharedString::from(
            "assistant-user-message",
        )))
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

fn render_assistant_card(
    message: &AssistantMessage,
    live: bool,
    streaming: bool,
    window: &mut Window,
    cx: &mut App,
) -> impl IntoElement {
    let theme = cx.theme();
    let thinking = message.thinking.clone();
    let content = message.content.clone();
    let markdown = markdown_with_math_fallback(&content);
    let placeholder = live && content.is_empty() && streaming;

    v_flex()
        .id("assistant-message-card")
        .w_full()
        .items_start()
        .child(
            div()
                .max_w(relative(0.88))
                .min_w(px(0.))
                .rounded_2xl()
                .bg(theme.list)
                .border_1()
                .border_color(theme.border)
                .px_3()
                .py_2()
                .gap_1()
                .when(!thinking.trim().is_empty(), |el| {
                    el.child(
                        div()
                            .w_full()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(prewrap(&thinking)),
                    )
                })
                .when(placeholder, |el| {
                    el.child(
                        div()
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .child("…"),
                    )
                })
                .when(!content.is_empty(), |el| {
                    el.child(
                        TextView::markdown(
                            ElementId::Name(SharedString::from("assistant-markdown")),
                            markdown,
                            window,
                            cx,
                        )
                        .style(Default::default()),
                    )
                }),
        )
}

/// Render plain text preserving newlines (mirrors the main chat's `prewrap`).
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
    use crate::assistant::view_state::{AssistantMessage as ViewMessage, AssistantPhase};

    #[test]
    fn speaker_labels_match_the_renderer() {
        assert_eq!(speaker_label(AssistantRole::User), "You");
        assert_eq!(speaker_label(AssistantRole::Assistant), "Aiden");
    }

    #[test]
    fn only_the_last_live_assistant_message_is_streaming() {
        let mut state = AssistantViewState::default();
        state.messages.extend([
            ViewMessage::user("q1"),
            ViewMessage::assistant("a1"),
            ViewMessage::user("q2"),
            ViewMessage::assistant(""),
        ]);
        state.phase = AssistantPhase::Streaming;
        assert!(!is_streaming_reply(&state, 1));
        assert!(is_streaming_reply(&state, 3));
        state.phase = AssistantPhase::Idle;
        assert!(!is_streaming_reply(&state, 3));
    }
}
