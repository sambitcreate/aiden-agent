//! Message transcript: user bubbles, assistant markdown (via gpui-component's
//! `TextView`), collapsible thinking blocks, the streaming assistant bubble,
//! and the terminal error banner with retry.

use std::{cell::RefCell, collections::HashMap, sync::Arc};

use aiden_core::{Attachment, AttachmentKind, ChatMessage, ChatRole};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use gpui::{
    div, img, prelude::FluentBuilder as _, px, relative, App, Context, ElementId, FontWeight,
    Image, ImageFormat, InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    spinner::Spinner,
    text::TextView,
    v_flex, ActiveTheme, Disableable as _, Icon, IconName, Sizable as _,
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
        let stream_content_persisted = stream_content_already_persisted(&snapshot);
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
            .children(snapshot.messages.iter().map(|message| {
                render_persisted_message(message, &self.attachment_image_cache, window, cx)
                    .into_any_element()
            }))
            .when(show_stream, |el| {
                el.child(render_stream_bubble(
                    &generation,
                    stream_content_persisted,
                    snapshot.assistant_persisting,
                    window,
                    cx,
                ))
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
    // A terminal failure owns the retry affordance even when its partial
    // content/timeline was durably appended to the transcript.
    if generation.error.is_some() {
        return true;
    }
    if generation.complete {
        !stream_content_already_persisted(snapshot)
    } else {
        true
    }
}

fn stream_content_already_persisted(snapshot: &ChatSnapshot) -> bool {
    let Some(generation) = &snapshot.generation else {
        return false;
    };
    snapshot.messages.last().is_some_and(|message| {
        message.role == ChatRole::Assistant && message.content == generation.text
    })
}

// ===========================================================================
// Persisted messages
// ===========================================================================

fn render_persisted_message(
    message: &ChatMessage,
    image_cache: &RefCell<HashMap<String, Arc<Image>>>,
    window: &mut Window,
    cx: &mut App,
) -> gpui::AnyElement {
    match message.role {
        ChatRole::User => render_user_bubble(message, image_cache, cx).into_any_element(),
        ChatRole::Assistant => render_assistant_message(message, window, cx).into_any_element(),
        ChatRole::System => div().into_any_element(),
    }
}

fn render_user_bubble(
    message: &ChatMessage,
    image_cache: &RefCell<HashMap<String, Arc<Image>>>,
    cx: &mut App,
) -> impl IntoElement {
    let muted = cx.theme().muted;
    h_flex()
        .id(ElementId::Name(SharedString::from(format!(
            "user-message-{}",
            message.id
        ))))
        .w_full()
        .justify_end()
        .child(
            v_flex()
                .max_w(relative(0.8))
                .items_end()
                .gap_1()
                .children(
                    message
                        .attachments
                        .as_deref()
                        .unwrap_or_default()
                        .iter()
                        .enumerate()
                        .map(|(index, attachment)| {
                            render_attachment(
                                attachment,
                                format!("{}:{index}:{}", message.id, attachment.id),
                                image_cache,
                                cx,
                            )
                        }),
                )
                .when(!message.content.is_empty(), |column| {
                    column.child(
                        div()
                            .rounded_2xl()
                            .bg(muted)
                            .px_4()
                            .py_2()
                            .child(prewrap(&message.content)),
                    )
                }),
        )
}

fn render_attachment(
    attachment: &Attachment,
    cache_key: String,
    image_cache: &RefCell<HashMap<String, Arc<Image>>>,
    cx: &mut App,
) -> gpui::AnyElement {
    if attachment.kind == AttachmentKind::Image {
        let image = cached_attachment_image(attachment, cache_key, image_cache);
        if let Some(image) = image {
            return v_flex()
                .gap_0p5()
                .items_end()
                .child(
                    div()
                        .max_w(px(420.))
                        .rounded_lg()
                        .overflow_hidden()
                        .child(img(image).max_h(px(160.)).max_w_full()),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child(attachment.name.clone()),
                )
                .into_any_element();
        }
    }

    h_flex()
        .max_w(px(320.))
        .items_center()
        .gap_1()
        .rounded_lg()
        .border_1()
        .border_color(cx.theme().border)
        .bg(cx.theme().secondary)
        .px_2()
        .py_1()
        .child(
            Icon::new(IconName::File)
                .xsmall()
                .text_color(cx.theme().muted_foreground),
        )
        .child(div().text_xs().truncate().child(attachment.name.clone()))
        .into_any_element()
}

pub(crate) fn cached_attachment_image(
    attachment: &Attachment,
    cache_key: String,
    image_cache: &RefCell<HashMap<String, Arc<Image>>>,
) -> Option<Arc<Image>> {
    image_cache.borrow().get(&cache_key).cloned().or_else(|| {
        let format = ImageFormat::from_mime_type(&attachment.mime_type)?;
        let bytes = STANDARD.decode(attachment.data.as_deref()?).ok()?;
        let image = Arc::new(Image::from_bytes(format, bytes));
        let mut cache = image_cache.borrow_mut();
        if cache.len() >= 64 {
            cache.clear();
        }
        cache.insert(cache_key, image.clone());
        Some(image)
    })
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
    content_already_persisted: bool,
    retry_disabled: bool,
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
                .filter(|timeline| !content_already_persisted && !timeline.steps.is_empty()),
            |el, timeline| el.child(timeline_feed(timeline, true, cx)),
        )
        .when(
            !content_already_persisted && (thinking_active || !thinking_text.trim().is_empty()),
            |el| {
                el.child(
                    v_flex()
                        .w_full()
                        .gap_1()
                        .child(
                            thinking_header(
                                "stream-thinking-header",
                                true,
                                Some(thinking_active),
                                cx,
                            )
                            .on_click(cx.listener(
                                |this, _event, _window, cx| {
                                    this.toggle_stream_thinking(cx);
                                },
                            )),
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
            },
        )
        .when(!content_already_persisted, |el| {
            el.child(
                TextView::markdown(
                    ElementId::Name(SharedString::from("stream-markdown")),
                    text,
                    window,
                    cx,
                )
                .style(Default::default()),
            )
        })
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
                            .disabled(retry_disabled)
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
            messages: Arc::new(vec![persisted]),
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
                provider_id: "provider".into(),
                provider_label: "Provider".into(),
                provider_is_local: false,
                cancellation: aiden_agent::ToolCancellation::new(),
                timeline: None,
            }),
            ..Default::default()
        };
        assert!(!should_show_stream_bubble(&snapshot));

        // A persisted partial must not hide the terminal error/retry surface.
        snapshot.generation.as_mut().unwrap().error = Some("network failed".into());
        assert!(should_show_stream_bubble(&snapshot));
        assert!(stream_content_already_persisted(&snapshot));
        snapshot.generation.as_mut().unwrap().error = None;

        // Different text than the persisted message → still show it.
        Arc::make_mut(&mut snapshot.messages)[0].content = "older".into();
        assert!(should_show_stream_bubble(&snapshot));

        // In-flight generations always show.
        snapshot.generation.as_mut().unwrap().complete = false;
        assert!(should_show_stream_bubble(&snapshot));
    }
}
