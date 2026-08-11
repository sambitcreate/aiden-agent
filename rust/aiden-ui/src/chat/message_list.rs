//! Message transcript: user bubbles, assistant markdown (via gpui-component's
//! `TextView` with per-code-block copy actions and tree-sitter highlighting),
//! collapsible thinking blocks, the streaming assistant bubble (with a blinking
//! cursor), hover-revealed message actions (copy + edit on user bubbles, copy +
//! retry on assistant bubbles), and the terminal error banner with retry.
//!
//! User bubbles render image attachments inline (scaled to a 400 px cap);
//! edit and retry actions call into the composer draft (`ComposerDraft`) and
//! the chat service respectively — see `chat_pane.rs` for the send-side
//! rebranch logic.
//!
//! # Markdown + code blocks
//!
//! Assistant content is rendered through `TextView::markdown`, which the
//! `gpui-component` crate parses into GFM nodes and syntax-highlights fenced
//! code blocks with tree-sitter (via the theme's `HighlightTheme`, wired by
//! `services::appearance`). The bounded `chat::markdown` compatibility pass
//! keeps unsupported KaTeX spans source-preserving and visibly labeled instead
//! of implying that the native view rendered them. The
//! `code_block_actions(...)` hook lets us attach a language label + copy button
//! to every fenced block without forking the parser, so tables, lists, inline
//! code, and links keep working.
//!
//! # Scroll behavior
//!
//! The transcript implements *stick-to-bottom*: it only pins to the bottom
//! while the user is already at the bottom (the typical case during streaming).
//! Scrolling up stops the pinning and the "Jump to bottom" button in
//! `chat_pane` appears instead. `scroll_at_bottom` is the shared geometry check
//! (the message-list render gates its delta-driven scroll on it).

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::Duration;

use aiden_core::{
    parse_subagent_message_reference_v1, Attachment, ChatMessage, ChatRole,
    SubagentMessageReferenceV1, SubagentRunSnapshotV1, SubagentRunState,
};
use gpui::{
    div, prelude::FluentBuilder as _, px, relative, rems, App, Context, ElementId, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonRounded, ButtonVariants as _},
    clipboard::Clipboard,
    h_flex,
    spinner::Spinner,
    text::TextView,
    v_flex, ActiveTheme, Icon, IconName, Sizable as _,
};

use crate::app::AppState;
use crate::chat::activity_feed::timeline_feed;
use crate::chat::composer::{
    attachment_image_element, composer_draft, CHAT_CONTENT_MAX_WIDTH_REMS, CHAT_DOCK_GUTTER_PX,
};
use crate::chat::markdown::markdown_with_math_fallback;
use crate::services::chat_service::{ChatSnapshot, GenerationState};

/// Pixels from the very bottom that still count as "at the bottom" — mirrors
/// the TS `ScrollArea` threshold (`remaining < 24`).
const BOTTOM_TOLERANCE_PX: f32 = 24.0;

/// Group name used to reveal the per-message action buttons on hover.
const MESSAGE_ACTIONS_GROUP: &str = "message-actions";

/// Max width for images rendered inline in user bubbles (gap 4 of the audit).
const MAX_ATTACHMENT_WIDTH_PX: f32 = 400.0;
const USER_BUBBLE_MAX_FRACTION: f32 = 0.8;
const USER_BUBBLE_PADDING_X_PX: f32 = 16.0;
const USER_BUBBLE_PADDING_Y_PX: f32 = 10.0;
const USER_BUBBLE_RADIUS_PX: f32 = 16.0;

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
        let live_subagents = snapshot.live_subagents.clone();
        // Reduced motion (parity audit UI §7): the persisted
        // `appearance.reduceMotion` override combined with the cached macOS
        // probe decides whether the streaming cursor may animate.
        let motion_reduced = cx
            .try_global::<crate::services::appearance::AidenAppearanceRuntime>()
            .map_or_else(
                || {
                    crate::app::motion_reduced(
                        self.service.read(cx).appearance.reduce_motion,
                        crate::app::system_reduced_motion(),
                    )
                },
                |runtime| runtime.motion_reduced,
            );
        // Stick-to-bottom: keep the transcript pinned while the user is at the
        // bottom (typical while streaming). Once they scroll up this stops
        // pinning and the "Jump to bottom" button (in `chat_pane`) takes over.
        follow_transcript_if_at_bottom(&scroll);

        v_flex()
            .id("message-list")
            .track_scroll(&scroll)
            .flex_1()
            .w_full()
            .overflow_y_scroll()
            // Re-render on scroll so the "Jump to bottom" button appears as
            // soon as the user scrolls away from the bottom (idle chats do not
            // otherwise re-render).
            .on_scroll_wheel({
                let app_id = cx.entity().entity_id();
                move |_event, _window, cx| cx.notify(app_id)
            })
            .child(
                v_flex()
                    .id("chat-content-column")
                    .w_full()
                    .max_w(rems(CHAT_CONTENT_MAX_WIDTH_REMS))
                    .mx_auto()
                    .px(px(CHAT_DOCK_GUTTER_PX))
                    .py_6()
                    .gap_5()
                    .children(snapshot.messages.iter().map(|message| {
                        render_persisted_message(message, window, cx).into_any_element()
                    }))
                    .when(show_stream, |el| {
                        el.child(render_stream_bubble(
                            &generation,
                            &live_subagents,
                            motion_reduced,
                            window,
                            cx,
                        ))
                    }),
            )
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
// Scroll geometry
// ===========================================================================

/// Whether the user is at (or within `BOTTOM_TOLERANCE_PX` of) the bottom of
/// the scroll viewport. GPUI scroll offsets are negative, while
/// `ScrollHandle::max_offset()` is the positive available distance; scrolling
/// up moves the offset toward zero.
pub(crate) fn scroll_at_bottom(scroll: &ScrollHandle) -> bool {
    is_near_bottom(
        f32::from(scroll.offset().y),
        // GPUI exposes the *distance* available to scroll as a positive
        // `Size`; its offset is negative as the reader moves down.
        -f32::from(scroll.max_offset().height),
        BOTTOM_TOLERANCE_PX,
    )
}

/// Request a bottom follow only from the pre-growth geometry. `ScrollHandle`
/// applies this request in its prepaint pass, after the new transcript height
/// is known. Keeping this small operation production-owned makes the subtle
/// "do not yank a reader back down" contract testable against GPUI itself.
pub(crate) fn follow_transcript_if_at_bottom(scroll: &ScrollHandle) {
    if scroll_at_bottom(scroll) {
        scroll.scroll_to_bottom();
    }
}

/// Pure geometry check, extracted for tests. `offset` and `max_offset` are
/// negative scroll coordinates; `max_offset` is `0` when the content fits.
fn is_near_bottom(offset: f32, max_offset: f32, tolerance: f32) -> bool {
    offset - max_offset <= tolerance
}

// ===========================================================================
// Persisted messages
// ===========================================================================

fn render_persisted_message(
    message: &ChatMessage,
    window: &mut Window,
    cx: &mut Context<AppState>,
) -> gpui::AnyElement {
    match message.role {
        ChatRole::User => render_user_bubble(message, cx).into_any_element(),
        ChatRole::Assistant => render_assistant_message(message, window, cx).into_any_element(),
        ChatRole::System => div().into_any_element(),
    }
}

fn render_user_bubble(message: &ChatMessage, cx: &mut Context<AppState>) -> impl IntoElement {
    let muted = cx.theme().muted;
    let muted_foreground = cx.theme().muted_foreground;
    let message_id = message.id.clone();
    let content = message.content.clone();
    h_flex()
        .id(ElementId::Name(SharedString::from(format!(
            "user-message-{}",
            message.id
        ))))
        .group(MESSAGE_ACTIONS_GROUP)
        .w_full()
        .justify_end()
        .child(
            v_flex()
                .items_end()
                .gap_1()
                .max_w(relative(USER_BUBBLE_MAX_FRACTION))
                // The persisted provenance is deliberately renderer-safe:
                // only the bounded catalog label is shown, never the private
                // instruction lease or supporting-file paths.
                .when_some(message.skill_provenance.as_ref(), |el, provenance| {
                    el.child(
                        h_flex()
                            .gap_1()
                            .items_center()
                            .px_2()
                            .py_0p5()
                            .rounded_full()
                            .bg(muted.opacity(0.72))
                            .text_xs()
                            .text_color(muted_foreground)
                            .child(skill_provenance_label(&provenance.name)),
                    )
                })
                // Image attachments render inline (max 400 px), scaled down
                // from the persisted base64 (gap 4).
                .when_some(
                    message
                        .attachments
                        .as_ref()
                        .filter(|attachments| !attachments.is_empty()),
                    |el, attachments| el.child(attachment_previews(attachments, cx)),
                )
                .when(!message.content.trim().is_empty(), |el| {
                    el.child(
                        div()
                            .rounded(px(USER_BUBBLE_RADIUS_PX))
                            .bg(muted)
                            .px(px(USER_BUBBLE_PADDING_X_PX))
                            .py(px(USER_BUBBLE_PADDING_Y_PX))
                            .child(prewrap(&message.content)),
                    )
                })
                .child(user_message_actions(&message_id, &content, cx)),
        )
}

fn skill_provenance_label(name: &str) -> String {
    format!("Skill · {name}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SubagentChipData {
    run_id: String,
    label: String,
    status: String,
    state: SubagentChipState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SubagentChipState {
    Queued,
    Starting,
    Running,
    Finished,
    Failed,
    TimedOut,
    Interrupted,
}

fn subagent_chips_for_message(
    message: &ChatMessage,
    cx: &mut Context<AppState>,
) -> gpui::AnyElement {
    let Some(reference) = message
        .subagents
        .as_ref()
        .and_then(parse_subagent_message_reference_v1)
    else {
        return div().into_any_element();
    };

    subagent_chips(
        format!("subagent-chips-{}", message.id),
        subagent_chip_data(reference),
        cx,
    )
}

fn subagent_chip_data(reference: SubagentMessageReferenceV1) -> Vec<SubagentChipData> {
    let chips = reference
        .items
        .unwrap_or_default()
        .into_iter()
        .map(|item| SubagentChipData {
            run_id: item.run_id,
            label: item.label,
            status: subagent_v1_state_label(item.state).to_string(),
            state: subagent_v1_chip_state(item.state),
        })
        .collect::<Vec<_>>();

    // Legacy references have run ids but no enriched items. Keep them
    // discoverable instead of silently dropping the persisted child-run
    // affordance; the panel remains the authoritative detail surface.
    let chips = if chips.is_empty() {
        reference
            .run_ids
            .into_iter()
            .enumerate()
            .map(|(index, run_id)| SubagentChipData {
                run_id,
                label: format!("Subagent {}", index + 1),
                status: "Finished".to_string(),
                state: SubagentChipState::Finished,
            })
            .collect()
    } else {
        chips
    };
    chips
}

fn live_subagent_chip_data(snapshots: &[SubagentRunSnapshotV1]) -> Vec<SubagentChipData> {
    snapshots
        .iter()
        .map(|snapshot| SubagentChipData {
            run_id: snapshot.run_id.clone(),
            label: snapshot.label.clone(),
            status: subagent_v1_state_label(snapshot.state).to_string(),
            state: subagent_v1_chip_state(snapshot.state),
        })
        .collect()
}

fn subagent_v1_state_label(state: SubagentRunState) -> &'static str {
    match state {
        SubagentRunState::Queued => "Queued",
        SubagentRunState::Starting => "Starting",
        SubagentRunState::Running => "Working",
        SubagentRunState::Completed => "Finished",
        SubagentRunState::Failed => "Failed",
        SubagentRunState::TimedOut => "Timed out",
        SubagentRunState::Interrupted => "Interrupted",
    }
}

fn subagent_v1_chip_state(state: SubagentRunState) -> SubagentChipState {
    match state {
        SubagentRunState::Queued => SubagentChipState::Queued,
        SubagentRunState::Starting => SubagentChipState::Starting,
        SubagentRunState::Running => SubagentChipState::Running,
        SubagentRunState::Failed => SubagentChipState::Failed,
        SubagentRunState::TimedOut => SubagentChipState::TimedOut,
        SubagentRunState::Interrupted => SubagentChipState::Interrupted,
        SubagentRunState::Completed => SubagentChipState::Finished,
    }
}

fn subagent_chips(
    id: String,
    chips: Vec<SubagentChipData>,
    cx: &mut Context<AppState>,
) -> gpui::AnyElement {
    if chips.is_empty() {
        return div().into_any_element();
    }
    let theme = cx.theme().clone();
    h_flex()
        .id(ElementId::Name(SharedString::from(id)))
        .w_full()
        .flex_wrap()
        .gap_1p5()
        .children(chips.into_iter().map(|chip| {
            let run_id = chip.run_id.clone();
            let (icon, color) = match chip.state {
                SubagentChipState::Queued => (IconName::LoaderCircle, theme.secondary),
                SubagentChipState::Starting => (IconName::LoaderCircle, theme.primary),
                SubagentChipState::Running => (IconName::LoaderCircle, theme.primary),
                SubagentChipState::Finished => (IconName::CircleCheck, theme.success),
                SubagentChipState::Failed => (IconName::CircleX, theme.danger),
                SubagentChipState::TimedOut => (IconName::TriangleAlert, theme.warning),
                SubagentChipState::Interrupted => (IconName::CircleX, theme.muted_foreground),
            };
            Button::new(ElementId::Name(SharedString::from(format!(
                "subagent-chip-{run_id}"
            ))))
            .small()
            .rounded(ButtonRounded::Small)
            .ghost()
            .px_2()
            .py_0p5()
            .tab_stop(true)
            .tooltip(format!("Open {}. Status: {}.", chip.label, chip.status))
            .child(Icon::new(icon).xsmall().text_color(color))
            .child(
                div()
                    .min_w(px(0.))
                    .max_w(px(180.))
                    .truncate()
                    .text_xs()
                    .child(chip.label),
            )
            .child(
                div()
                    .max_w(px(120.))
                    .truncate()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(chip.status),
            )
            .on_click(cx.listener(move |this, _event, window, cx| {
                this.open_subagent_run(&run_id, window, cx);
            }))
            .into_any_element()
        }))
        .into_any_element()
}

fn render_assistant_message(
    message: &ChatMessage,
    window: &mut Window,
    cx: &mut Context<AppState>,
) -> impl IntoElement {
    let muted = cx.theme().muted;
    let message_id = message.id.clone();
    v_flex()
        .id(ElementId::Name(SharedString::from(format!(
            "assistant-message-{}",
            message.id
        ))))
        .group(MESSAGE_ACTIONS_GROUP)
        .w_full()
        .gap_3()
        // Persisted activity timeline: thinking/tool steps survive reloads
        // via the message's `timeline` field.
        .when_some(
            message
                .timeline
                .as_ref()
                .filter(|timeline| !timeline.steps.is_empty()),
            |el, timeline| el.child(timeline_feed(timeline, false, window, cx)),
        )
        .child(subagent_chips_for_message(message, cx))
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
        .child(assistant_markdown(
            &format!("assistant-markdown-{}", message.id),
            message.content.clone(),
            window,
            cx,
        ))
        .child(
            h_flex()
                .w_full()
                .justify_start()
                .child(assistant_message_actions(&message_id, &message.content, cx)),
        )
}

// ===========================================================================
// Streaming bubble + thinking
// ===========================================================================

fn render_stream_bubble(
    generation: &Option<GenerationState>,
    live_subagents: &[SubagentRunSnapshotV1],
    motion_reduced: bool,
    window: &mut Window,
    cx: &mut Context<AppState>,
) -> impl IntoElement {
    let muted = cx.theme().muted;
    let danger = cx.theme().danger;
    let foreground = cx.theme().foreground;
    let muted_foreground = cx.theme().muted_foreground;
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
    let streaming = generation
        .as_ref()
        .is_some_and(|generation| !generation.complete);
    let error = generation
        .as_ref()
        .and_then(|generation| generation.error.clone());
    let error_retryable = should_show_stream_retry(generation.as_ref());
    let live_timeline = generation
        .as_ref()
        .and_then(|generation| generation.timeline.clone());

    // Blinking streaming cursor: a keyed state per generation (`counter`)
    // drives the blink via a timer loop that stops once the generation is no
    // longer active, so no state leaks after streaming ends. Under reduced
    // motion the blink loop is skipped — the cursor renders solid, matching
    // the TS streaming-reveal collapse (parity audit UI §7).
    let cursor_visible = {
        let cursor = window.use_keyed_state(
            ElementId::Name(SharedString::from(format!(
                "stream-cursor-{}",
                generation
                    .as_ref()
                    .map_or(0, |generation| generation.counter)
            ))),
            cx,
            |_, _| StreamCursorState::default(),
        );
        let visible = cursor.read(cx).visible;
        if streaming && !cursor.read(cx).spawned && !motion_reduced {
            let cursor_entity = cursor.clone();
            cursor.update(cx, |state, _cx| state.spawned = true);
            cx.spawn(async move |this, cx| loop {
                cx.background_executor()
                    .timer(Duration::from_millis(450))
                    .await;
                let active = this.upgrade().is_some_and(|app| {
                    app.read_with(cx, |app, cx| app.service.read(cx).generation_active())
                        .unwrap_or(false)
                });
                if !active {
                    break;
                }
                let alive = cursor_entity.update(cx, |state, cx| {
                    state.visible = !state.visible;
                    cx.notify();
                });
                if alive.is_err() {
                    break;
                }
            })
            .detach();
        }
        visible
    };

    v_flex()
        .id("stream-bubble")
        .w_full()
        .gap_3()
        // Live activity timeline: tool steps and thinking stretches render as
        // they're recorded by the driver's `TimelineProjector`.
        .when_some(
            live_timeline
                .as_ref()
                .filter(|timeline| !timeline.steps.is_empty()),
            |el, timeline| el.child(timeline_feed(timeline, true, window, cx)),
        )
        .when(!live_subagents.is_empty(), |el| {
            el.child(subagent_chips(
                "live-subagent-chips".to_string(),
                live_subagent_chip_data(live_subagents),
                cx,
            ))
        })
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
        .child(assistant_markdown("stream-markdown", text, window, cx))
        .when(streaming, |el| {
            // Thin block cursor at the end of the streamed reply. Blinks via
            // the timer above; a static character keeps layout stable.
            el.child(
                h_flex()
                    .id("stream-cursor-row")
                    .w_full()
                    .items_center()
                    .child(
                        div()
                            .text_color(muted_foreground)
                            .opacity(if cursor_visible { 1.0 } else { 0.0 })
                            .child("▋"),
                    ),
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
                    .when(!streaming && error_retryable, |el| {
                        el.child(
                            Button::new("stream-retry")
                                .small()
                                .ghost()
                                .label("Retry")
                                .on_click(cx.listener(|this, _event, _window, cx| {
                                    this.service
                                        .update(cx, |service, cx| service.retry_last(cx));
                                })),
                        )
                    }),
            )
        })
}

fn should_show_stream_retry(generation: Option<&GenerationState>) -> bool {
    generation.is_some_and(|generation| {
        generation.complete && generation.error.is_some() && generation.error_retryable
    })
}

// ===========================================================================
// Markdown + code-block copy actions
// ===========================================================================

/// A markdown `TextView` for assistant content. Fenced code blocks get a
/// language label chip + copy button via `code_block_actions`; the code itself
/// is syntax-highlighted by the library (tree-sitter, theme tokens) and styled
/// with a muted background + monospace font by the `CodeBlock` node renderer.
fn assistant_markdown(
    key: &str,
    content: impl Into<SharedString>,
    window: &mut Window,
    cx: &mut App,
) -> TextView {
    let element_key = key.to_string();
    let content = content.into();
    TextView::markdown(
        ElementId::Name(SharedString::from(key.to_string())),
        markdown_with_math_fallback(&content),
        window,
        cx,
    )
    .style(Default::default())
    .code_block_actions(move |code_block, _window, cx| {
        let lang = code_block.lang().map(|lang| lang.to_string());
        code_block_actions_element(lang.as_deref(), &code_block.code(), &element_key, cx)
    })
}

/// The per-code-block overlay rendered by `TextView::markdown`: a language
/// label plus a copy button (with a Copy → Check flash). Styled with theme
/// tokens only.
fn code_block_actions_element(
    lang: Option<&str>,
    code: &str,
    element_key: &str,
    cx: &mut App,
) -> gpui::AnyElement {
    let muted_foreground = cx.theme().muted_foreground;
    let id = ElementId::Name(SharedString::from(format!(
        "copy-{}-{}",
        element_key,
        stable_hash(code)
    )));
    h_flex()
        .gap_1()
        .items_center()
        .px_2()
        .py_0p5()
        .child(
            div()
                .text_xs()
                .text_color(muted_foreground)
                .child(code_language_label(lang)),
        )
        .child(Clipboard::new(id).value(code.to_string()))
        .into_any_element()
}

/// The language label shown on a code block, defaulting to "text" for fenced
/// blocks without a language hint (matches the TS `CodeBlock`).
fn code_language_label(lang: Option<&str>) -> String {
    match lang.map(str::trim).filter(|lang| !lang.is_empty()) {
        Some(lang) => lang.to_string(),
        None => "text".to_string(),
    }
}

/// Deterministic content hash used to key copy buttons per code block, so the
/// Copy → Check state never leaks between blocks.
fn stable_hash(input: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    input.hash(&mut hasher);
    hasher.finish()
}

// ===========================================================================
// Hover actions
// ===========================================================================

/// A hover-revealed row of message actions (copy + edit on user bubbles, copy +
/// retry on assistant bubbles). Reveals on group hover and on keyboard
/// focus-within so the actions stay reachable without a mouse.
fn hover_reveal(base_id: &str, children: impl IntoElement) -> gpui::Stateful<gpui::Div> {
    div()
        .id(ElementId::Name(SharedString::from(format!(
            "{base_id}-wrap"
        ))))
        .opacity(0.0)
        .group_hover(MESSAGE_ACTIONS_GROUP, |style| style.opacity(1.0))
        .focusable()
        .in_focus(|style| style.opacity(1.0))
        .child(h_flex().gap_1().items_center().child(children))
}

/// Copy + edit actions for a user bubble. Edit loads the message text into the
/// composer and marks it as "editing" (the send button then rebranches).
fn user_message_actions(
    message_id: &str,
    content: &str,
    cx: &mut Context<AppState>,
) -> gpui::AnyElement {
    let message_id = message_id.to_string();
    let content = content.to_string();
    // Owned copies for the move-in listener; the Clipboard consumes `content`.
    let edit_text = content.clone();
    let copy_id = format!("copy-user-{message_id}");
    let edit_id = format!("edit-user-{message_id}");
    let actions_id = format!("user-actions-{message_id}");
    let edit = Button::new(ElementId::Name(SharedString::from(edit_id)))
        .small()
        .ghost()
        .icon(IconName::Replace)
        .tooltip("Edit message")
        .on_click(cx.listener(move |this, _event, window, cx| {
            this.composer_input.update(cx, |input, inner| {
                input.set_value(edit_text.clone(), window, inner);
            });
            composer_draft(cx).begin_edit(message_id.clone());
            this.composer_input
                .update(cx, |input, inner| input.focus(window, inner));
            cx.notify();
        }));
    hover_reveal(
        &actions_id,
        h_flex()
            .gap_1()
            .items_center()
            .child(Clipboard::new(ElementId::Name(SharedString::from(copy_id))).value(content))
            .child(edit),
    )
    .into_any_element()
}

/// Copy + retry actions for an assistant bubble. Retry regenerates from the
/// last user turn (`retry_last` — the service truncates the failed assistant
/// turn before resending).
fn assistant_message_actions(
    message_id: &str,
    content: &str,
    cx: &mut Context<AppState>,
) -> gpui::AnyElement {
    let message_id = message_id.to_string();
    let content = content.to_string();
    let retry = Button::new(ElementId::Name(SharedString::from(format!(
        "retry-assistant-{message_id}"
    ))))
    .small()
    .ghost()
    .icon(IconName::Undo2)
    .tooltip("Retry (regenerate from the last message)")
    .on_click(cx.listener(|this, _event, _window, cx| {
        this.service
            .update(cx, |service, cx| service.retry_last(cx));
    }));
    hover_reveal(
        &format!("assistant-actions-{message_id}"),
        h_flex()
            .gap_1()
            .items_center()
            .child(
                Clipboard::new(ElementId::Name(SharedString::from(format!(
                    "copy-assistant-{message_id}"
                ))))
                .value(content),
            )
            .child(retry),
    )
    .into_any_element()
}

// ===========================================================================
// Attachment rendering (gap 4)
// ===========================================================================

/// Inline rendering of a message's attachments: images scale to at most
/// [`MAX_ATTACHMENT_WIDTH_PX`] wide (object-fit contain); anything else
/// (unrenderable formats, text attachments) falls back to a file chip.
fn attachment_previews(attachments: &[Attachment], cx: &mut Context<AppState>) -> impl IntoElement {
    h_flex()
        .id("user-attachments")
        .flex_wrap()
        .justify_end()
        .gap_2()
        .children(attachments.iter().map(|attachment| {
            if let Some(image) = attachment_image_element(attachment, MAX_ATTACHMENT_WIDTH_PX) {
                image
            } else {
                attachment_file_chip(attachment, cx).into_any_element()
            }
        }))
}

/// A small file chip for attachments that can't be rendered inline.
fn attachment_file_chip(attachment: &Attachment, cx: &mut App) -> impl IntoElement {
    let theme = cx.theme();
    h_flex()
        .gap_1p5()
        .items_center()
        .px_2p5()
        .py_1p5()
        .rounded_lg()
        .bg(theme.muted)
        .border_1()
        .border_color(theme.border)
        .child(
            Icon::new(IconName::File)
                .small()
                .text_color(theme.muted_foreground),
        )
        .child(
            div()
                .max_w(px(192.))
                .truncate()
                .text_sm()
                .child(attachment.name.clone()),
        )
}

// ===========================================================================
// Misc
// ===========================================================================

/// Blink state for the streaming cursor. One instance per generation counter.
struct StreamCursorState {
    /// Whether the cursor block is currently shown. Starts visible so the
    /// cursor appears immediately when streaming begins.
    visible: bool,
    /// Whether the blink timer loop was started for this generation.
    spawned: bool,
}

impl Default for StreamCursorState {
    fn default() -> Self {
        Self {
            visible: true,
            spawned: false,
        }
    }
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
        .when(
            crate::services::appearance::pointer_cursors_enabled(cx),
            |el| el.cursor_pointer(),
        )
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
    use gpui::{point, size, AppContext as _, Render, ScrollDelta, ScrollWheelEvent};

    /// A real GPUI surface using the same production follow helper as the
    /// transcript. This is deliberately not a geometry-only test: `draw`
    /// exercises `ScrollHandle`'s prepaint-time bottom request and
    /// `simulate_event` exercises the native scroll listener.
    struct ScrollFollowHarness {
        scroll: ScrollHandle,
        rows: usize,
        follow_new_content: bool,
    }

    impl Render for ScrollFollowHarness {
        fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            if self.follow_new_content {
                follow_transcript_if_at_bottom(&self.scroll);
            }
            v_flex()
                .id("scroll-follow-harness")
                .track_scroll(&self.scroll)
                .h_full()
                .w_full()
                .overflow_y_scroll()
                .children((0..self.rows).map(|row| {
                    div()
                        .id(ElementId::Name(SharedString::from(format!("row-{row}"))))
                        .flex_none()
                        .h(px(20.))
                        .w_full()
                }))
        }
    }

    #[test]
    fn user_bubble_geometry_matches_the_canonical_contract() {
        assert_eq!(USER_BUBBLE_MAX_FRACTION, 0.8);
        assert_eq!(USER_BUBBLE_PADDING_X_PX, 16.0);
        assert_eq!(USER_BUBBLE_PADDING_Y_PX, 10.0);
        assert_eq!(USER_BUBBLE_RADIUS_PX, 16.0);
    }

    #[test]
    fn skill_provenance_uses_only_the_bounded_display_name() {
        assert_eq!(skill_provenance_label("review"), "Skill · review");
    }

    #[test]
    fn persisted_subagent_reference_projects_status_and_label_into_chip_data() {
        let reference: SubagentMessageReferenceV1 = serde_json::from_value(serde_json::json!({
            "version": 1,
            "generationId": "chat:1",
            "runIds": ["run-a"],
            "items": [{
                "runId": "run-a",
                "label": "Review workspace",
                "role": "scout",
                "state": "failed"
            }],
            "total": 1,
            "completed": 0,
            "failed": 1,
            "timedOut": 0,
            "interrupted": 0
        }))
        .unwrap();
        let chips = subagent_chip_data(reference);
        assert_eq!(
            chips,
            vec![SubagentChipData {
                run_id: "run-a".into(),
                label: "Review workspace".into(),
                status: "Failed".into(),
                state: SubagentChipState::Failed,
            }]
        );
    }

    #[test]
    fn legacy_subagent_reference_keeps_run_ids_clickable_with_safe_fallback_labels() {
        let reference: SubagentMessageReferenceV1 = serde_json::from_value(serde_json::json!({
            "version": 1,
            "generationId": "chat:2",
            "runIds": ["run-a", "run-b"],
            "total": 2,
            "completed": 2,
            "failed": 0,
            "timedOut": 0,
            "interrupted": 0
        }))
        .unwrap();
        let chips = subagent_chip_data(reference);
        assert_eq!(chips[0].label, "Subagent 1");
        assert_eq!(chips[1].run_id, "run-b");
    }

    #[test]
    fn live_subagent_snapshots_keep_active_statuses_and_terminal_tones() {
        let snapshots: Vec<SubagentRunSnapshotV1> = vec![
            serde_json::from_value(serde_json::json!({
                "version": 1,
                "runId": "run-queued",
                "groupId": "group-1",
                "generationId": "chat:1",
                "childId": "child-1",
                "chatId": "chat",
                "workspaceId": "workspace",
                "revision": 1,
                "role": "scout",
                "label": "Queued scout",
                "taskPreview": "queue",
                "state": "queued",
                "startedAt": 1,
                "updatedAt": 1,
                "modelId": "model",
                "turns": 0,
                "tools": 0,
                "tokens": 0,
                "warnings": []
            }))
            .unwrap(),
            serde_json::from_value(serde_json::json!({
                "version": 1,
                "runId": "run-failed",
                "groupId": "group-1",
                "generationId": "chat:1",
                "childId": "child-2",
                "chatId": "chat",
                "workspaceId": "workspace",
                "revision": 2,
                "role": "reviewer",
                "label": "Failed review",
                "taskPreview": "review",
                "state": "failed",
                "startedAt": 2,
                "updatedAt": 2,
                "modelId": "model",
                "turns": 1,
                "tools": 1,
                "tokens": 1,
                "warnings": []
            }))
            .unwrap(),
        ];
        let chips = live_subagent_chip_data(&snapshots);
        assert_eq!(chips[0].status, "Queued");
        assert_eq!(chips[0].state, SubagentChipState::Queued);
        assert_eq!(chips[1].status, "Failed");
        assert_eq!(chips[1].state, SubagentChipState::Failed);
    }

    #[test]
    fn live_chip_render_contract_is_focusable_and_routes_to_subagent_panel() {
        let source = include_str!("message_list.rs");
        assert!(source.contains(".tab_stop(true)"));
        assert!(source.contains("live-subagent-chips"));
        assert!(source.contains("open_subagent_run"));
    }

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
            skill_provenance: None,
            timeline: None,
            subagents: None,
        };
        let mut snapshot = ChatSnapshot {
            messages: vec![persisted],
            generation: Some(GenerationState {
                chat_id: "c".into(),
                counter: 1,
                provider_id: "anthropic".into(),
                text: "the answer".into(),
                thinking: String::new(),
                thinking_active: false,
                thinking_expanded: false,
                complete: true,
                error: None,
                error_retryable: false,
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

    #[test]
    fn admission_error_never_retries_an_older_persisted_turn() {
        let mut generation = GenerationState {
            chat_id: "c".into(),
            counter: 1,
            provider_id: "anthropic".into(),
            text: String::new(),
            thinking: String::new(),
            thinking_active: false,
            thinking_expanded: false,
            complete: true,
            error: Some("The message could not be saved, so it was not sent.".into()),
            error_retryable: false,
            model: None,
            timeline: None,
        };
        assert!(!should_show_stream_retry(Some(&generation)));

        generation.error = Some("The provider request failed.".into());
        generation.error_retryable = true;
        assert!(should_show_stream_retry(Some(&generation)));
    }

    #[test]
    fn near_bottom_geometry() {
        // Empty list / content that fits → at bottom.
        assert!(is_near_bottom(0.0, 0.0, 24.0));
        // Exactly at the bottom of a long transcript.
        assert!(is_near_bottom(-500.0, -500.0, 24.0));
        // Within the 24px tolerance of the bottom → still "at bottom".
        assert!(is_near_bottom(-480.0, -500.0, 24.0));
        // Scrolled up beyond the tolerance → not at the bottom.
        assert!(!is_near_bottom(-460.0, -500.0, 24.0));
        // All the way at the top of a long transcript.
        assert!(!is_near_bottom(0.0, -500.0, 24.0));
    }

    #[test]
    fn fresh_scroll_handle_counts_as_at_bottom() {
        assert!(scroll_at_bottom(&ScrollHandle::new()));
    }

    #[gpui::test]
    fn scroll_handle_prepaint_follows_only_until_the_user_scrolls_away(
        cx: &mut gpui::TestAppContext,
    ) {
        let cx = cx.add_empty_window();
        let scroll = ScrollHandle::new();
        let view = cx.update(|_, app| {
            app.new(|_| ScrollFollowHarness {
                scroll: scroll.clone(),
                rows: 10,
                follow_new_content: true,
            })
        });
        let draw = |cx: &mut gpui::VisualTestContext| {
            cx.draw(point(px(0.), px(0.)), size(px(100.), px(100.)), |_, _| {
                div().size_full().child(view.clone())
            })
        };

        draw(cx);
        assert_eq!(scroll.max_offset().height, px(100.));
        assert_eq!(scroll.offset().y, px(-100.));

        // More transcript content appears while the reader is at the bottom:
        // the production helper requests a bottom follow, applied in prepaint.
        view.update(cx, |harness, _| harness.rows = 15);
        draw(cx);
        assert_eq!(scroll.max_offset().height, px(200.));
        assert_eq!(scroll.offset().y, px(-200.));

        // A real wheel event moves the reader away. The subsequent content
        // growth must retain that reading position instead of snapping down.
        cx.simulate_event(ScrollWheelEvent {
            position: point(px(10.), px(10.)),
            delta: ScrollDelta::Pixels(point(px(0.), px(80.))),
            ..Default::default()
        });
        assert_eq!(scroll.offset().y, px(-120.));
        assert!(!scroll_at_bottom(&scroll));
        view.update(cx, |harness, _| harness.rows = 20);
        draw(cx);
        assert_eq!(scroll.max_offset().height, px(300.));
        assert_eq!(scroll.offset().y, px(-120.));

        // The explicit Jump-to-bottom affordance restores follow. Subsequent
        // content growth then remains pinned through the same GPUI path.
        scroll.scroll_to_bottom();
        draw(cx);
        assert_eq!(scroll.offset().y, px(-300.));
        view.update(cx, |harness, _| harness.rows = 25);
        draw(cx);
        assert_eq!(scroll.max_offset().height, px(400.));
        assert_eq!(scroll.offset().y, px(-400.));
    }

    #[test]
    fn code_language_label_defaults_to_text() {
        assert_eq!(code_language_label(None), "text");
        assert_eq!(code_language_label(Some("rust")), "rust");
        assert_eq!(code_language_label(Some("json")), "json");
        // Whitespace-only hints fall back to "text".
        assert_eq!(code_language_label(Some("  ")), "text");
    }

    #[test]
    fn copy_button_ids_are_stable_and_distinct() {
        assert_eq!(stable_hash("fn main() {}"), stable_hash("fn main() {}"));
        assert_ne!(stable_hash("fn main() {}"), stable_hash("let x = 1;"));
    }
}
