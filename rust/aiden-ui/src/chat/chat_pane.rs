//! The chat pane: message transcript, empty states, and the composer.
//!
//! The composer (gap 4 / gap 6 of the parity audit) stages image attachments
//! (file picker + clipboard paste), previews them as thumbnails above the
//! input, and supports editing a prior user message: clicking the edit affordance
//! in `message_list.rs` loads the message text into the composer and marks it as
//! "editing"; sending then truncates the transcript back to (and including) the
//! edited message and re-sends the text as a fresh turn (a rebranch). The
//! pending draft lives in a GPUI `Global` ([`ComposerDraft`]) so the hover
//! actions in `message_list.rs` can mutate it without threading an entity.

use std::path::PathBuf;

use aiden_core::Attachment;
use gpui::{
    div, prelude::FluentBuilder as _, px, rems, AppContext as _, Context, ElementId,
    Focusable as _, InteractiveElement as _, IntoElement, ParentElement as _, PathPromptOptions,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{Input, Paste},
    notification::Notification,
    v_flex, ActiveTheme, Disableable as _, Icon, IconName, PixelsExt as _, Sizable as _,
    WindowExt as _,
};

use crate::app::AppState;
use crate::chat::composer::{
    attachment_from_image_bytes, attachment_image_element, composer_draft, format_bytes,
    read_image_attachment, renderable_image_format, AttachmentError, ComposerDraft,
    CHAT_CONTENT_MAX_WIDTH_REMS, CHAT_DOCK_GUTTER_PX, MAX_IMAGE_BYTES,
};
use crate::chat::message_list::scroll_at_bottom;
use crate::chat::model_pad_picker::{
    model_grid_axes, model_grid_coordinate, model_grid_size, BoundsAwarePadSurface, ModelDirection,
    ModelPadKey, ModelPoint, PadPointerEvent,
};
use crate::chat::model_picker::{ComposerModelPickerEvent, ModelPickerPins, PickerTab};
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
            // The transcript: stick-to-bottom scroll region plus a floating
            // "Jump to bottom" button that appears once the user scrolls up
            // away from the bottom (mirrors the TS `ScrollArea`).
            let show_jump = !scroll_at_bottom(&self.message_scroll);
            return v_flex()
                .id("message-list-region")
                .relative()
                .flex_1()
                .w_full()
                .child(self.message_list(window, cx))
                .when(show_jump, |el| {
                    el.child(
                        div().absolute().bottom_2().right_4().child(
                            Button::new("jump-to-bottom")
                                .small()
                                .icon(IconName::ArrowDown)
                                .label("Jump to bottom")
                                .on_click(cx.listener(|this, _event, window, cx| {
                                    this.message_scroll.scroll_to_bottom();
                                    // The scroll flag is consumed in the next
                                    // prepaint; re-render afterwards so the
                                    // button disappears once pinned.
                                    cx.defer_in(window, |_this, _window, cx| cx.notify());
                                })),
                        ),
                    )
                })
                .into_any_element();
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

    /// The composer: pending-attachment thumbnails, edit banner, multiline
    /// input, and the footer row (attach button + model label + send/stop).
    /// Pasting an image (⌘V) while the input is focused is intercepted here
    /// (capture phase, before the input's own text-paste runs) and staged as an
    /// attachment.
    fn composer(
        &self,
        snapshot: &ChatSnapshot,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        let generating = snapshot
            .generation
            .as_ref()
            .is_some_and(|generation| !generation.complete);
        let text = self.composer_input.read(cx).value().to_string();
        let has_text = !text.trim().is_empty();
        let draft = composer_draft(cx).clone();
        let composer_focused = self
            .composer_input
            .read(cx)
            .focus_handle(cx)
            .is_focused(window);
        let can_send = has_text
            && !generating
            && snapshot.has_providers
            && snapshot.has_key_for_selection
            && snapshot.selection.is_some();

        let readiness = if !snapshot.has_providers {
            Some("Select a provider and model to start chatting.".to_string())
        } else if snapshot.selection.is_none() {
            Some("Pick a model below to start chatting.".to_string())
        } else if !snapshot.has_key_for_selection {
            Some("The selected provider has no API key yet.".to_string())
        } else {
            None
        };

        let context_busy = generating || draft.attaching;
        v_flex()
            .id("composer")
            .w_full()
            .max_w(rems(CHAT_CONTENT_MAX_WIDTH_REMS))
            .mx_auto()
            .px(px(CHAT_DOCK_GUTTER_PX))
            .pb_4()
            .pt_3()
            .child(self.workspace_bar(context_busy, window, cx))
            .child(
                v_flex()
                    .id("composer-shell")
                    // Paste interception: runs in the capture phase (ancestor
                    // before the focused input) so image clips are staged as
                    // attachments and the input's text-paste is suppressed for
                    // them; text clips fall through to the input unchanged.
                    .capture_action({
                        let this = cx.entity();
                        move |_: &Paste, _window, cx| {
                            let handled = this.update(cx, |this, cx| this.handle_paste_image(cx));
                            if handled {
                                cx.stop_propagation();
                            }
                        }
                    })
                    .w_full()
                    .rounded_2xl()
                    .bg(theme.popover)
                    .border_1()
                    .border_color(if composer_focused {
                        theme.ring
                    } else {
                        theme.input
                    })
                    .shadow_md()
                    .p_2p5()
                    .gap_1()
                    .when(draft.has_attachments(), |el| {
                        el.child(self.attachment_row(&draft, cx))
                    })
                    .when(draft.is_editing(), |el| el.child(self.editing_banner(cx)))
                    .child(
                        Input::new(&self.composer_input)
                            .appearance(false)
                            .bordered(false)
                            .focus_bordered(false)
                            .max_h(px(192.)),
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
                            .min_w(px(0.))
                            .flex_wrap()
                            .items_center()
                            .justify_between()
                            .gap_1()
                            .child(
                                h_flex()
                                    .gap_1()
                                    .items_center()
                                    .flex_shrink_0()
                                    .child(self.attach_button(&draft, generating, cx)),
                            )
                            .child(
                                h_flex()
                                    .gap_1()
                                    .items_center()
                                    .min_w(px(0.))
                                    .flex_1()
                                    .flex_wrap()
                                    .justify_end()
                                    .child(self.composer_model_picker(
                                        !snapshot.has_providers || generating,
                                        window,
                                        cx,
                                    ))
                                    .child(
                                        Button::new("composer-voice")
                                            .ghost()
                                            .small()
                                            // gpui-component 0.5 does not ship a microphone asset,
                                            // so draw the tiny semantic glyph locally while keeping
                                            // the control in Electron's icon-only 24px footprint.
                                            .size(px(24.))
                                            .p_0()
                                            .child(microphone_glyph(theme.foreground))
                                            .disabled(generating)
                                            .tooltip("Voice input (⌘⇧D)")
                                            .on_click(cx.listener(|this, _event, window, cx| {
                                                this.composer_input.update(cx, |input, cx| {
                                                    input.focus(window, cx);
                                                });
                                                this.toggle_dictation_from_composer(cx);
                                            })),
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
                                            .tooltip(if draft.is_editing() {
                                                "Save edited message"
                                            } else {
                                                "Send message (Enter)"
                                            })
                                            .on_click(cx.listener(|this, _event, window, cx| {
                                                this.submit_composer(window, cx);
                                            }))
                                            .into_any_element()
                                    }),
                            ),
                    ),
            )
    }

    fn composer_model_picker(
        &self,
        disabled: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let runtime = cx
            .try_global::<crate::chat::model_pad_picker::ModelPadRuntime>()
            .cloned();
        self.model_picker
            .update(cx, |picker, _| picker.ensure_pad_revision(runtime.as_ref()));
        let pinned = cx.default_global::<ModelPickerPins>().keys.clone();
        let (open, tab, selection, items, all_items, trigger_item, label) = {
            let picker = self.model_picker.read(cx);
            let selection = picker.selection().map(str::to_string);
            let items = picker
                .filtered_pinned_first(&pinned)
                .into_iter()
                .cloned()
                .collect::<Vec<_>>();
            let all_items = picker.items.clone();
            let trigger_item = selection
                .as_deref()
                .and_then(|key| picker.items.iter().find(|item| item.value_key() == key))
                .cloned();
            let label = trigger_item
                .as_ref()
                .map(model_picker_item_summary)
                .unwrap_or_else(|| "Select model".into());
            (
                picker.open,
                picker.tab,
                selection,
                items,
                all_items,
                trigger_item,
                label,
            )
        };
        let trigger_disabled = !model_picker_trigger_enabled(disabled, all_items.len());
        let trigger_focus_bg = cx.theme().list_active;
        let trigger = Button::new("composer-model-picker-trigger")
            .ghost()
            .small()
            .label(label)
            .when_some(trigger_item.as_ref(), |button, item| {
                button.icon(model_provider_icon(item))
            })
            .tab_stop(false)
            .disabled(trigger_disabled)
            .tooltip("Choose model (Local or Hosted)")
            .on_click(cx.listener(|this, _event, window, cx| {
                let runtime = cx
                    .try_global::<crate::chat::model_pad_picker::ModelPadRuntime>()
                    .cloned();
                this.model_picker.update(cx, |picker, cx| {
                    picker.toggle(runtime.as_ref());
                    cx.notify();
                });
                if !this.model_picker.read(cx).open {
                    this.model_picker_input
                        .update(cx, |input, cx| input.set_value("", window, cx));
                    this.model_picker_trigger_focus.focus(window);
                } else if this.model_picker.read(cx).open
                    && this.model_picker.read(cx).tab == PickerTab::List
                {
                    this.model_picker_input
                        .update(cx, |input, cx| input.focus(window, cx));
                } else if this.model_picker.read(cx).open {
                    this.model_picker_pad_focus.focus(window);
                }
            }));
        let trigger = div()
            .track_focus(&self.model_picker_trigger_focus)
            .tab_stop(!trigger_disabled)
            .focus(move |style| style.rounded_md().bg(trigger_focus_bg))
            .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                if !matches!(event.keystroke.key.as_str(), "enter" | "space") {
                    return;
                }
                if this.service.read(cx).generation_active()
                    || this.model_picker.read(cx).items.is_empty()
                {
                    return;
                }
                let runtime = cx
                    .try_global::<crate::chat::model_pad_picker::ModelPadRuntime>()
                    .cloned();
                this.model_picker.update(cx, |picker, cx| {
                    picker.toggle(runtime.as_ref());
                    cx.notify();
                });
                if !this.model_picker.read(cx).open {
                    this.model_picker_input
                        .update(cx, |input, cx| input.set_value("", window, cx));
                    this.model_picker_trigger_focus.focus(window);
                } else if this.model_picker.read(cx).tab == PickerTab::Pad {
                    this.model_picker_pad_focus.focus(window);
                } else {
                    this.model_picker_input
                        .update(cx, |input, cx| input.focus(window, cx));
                }
                cx.stop_propagation();
            }))
            .child(trigger);
        if !open {
            return trigger.into_any_element();
        }
        let pad_items = runtime
            .as_ref()
            .map(|runtime| {
                all_items
                    .iter()
                    .filter_map(|item| {
                        runtime
                            .layout
                            .placements
                            .get(item.pad_key())
                            .map(|placement| (item.clone(), placement.x, placement.y))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let active = self.model_picker.read(cx).active.clone();
        let pad_has_positioned_models = !pad_items.is_empty();
        let model_pad_settings_blocked = self.workspace_state.read(cx).git_busy;
        let pad = if pad_items.is_empty() {
            v_flex()
                .h(px(MODEL_PAD_SURFACE_SIZE_PX))
                .items_center()
                .justify_center()
                .gap_2()
                .child(div().text_sm().child("Your Model Pad is empty"))
                .child(
                    div()
                        .text_xs()
                        .text_color(cx.theme().muted_foreground)
                        .child("Arrange a few models in Settings to use the spatial picker."),
                )
                .child(
                    div()
                        .track_focus(&self.model_picker_empty_pad_focus)
                        .tab_stop(true)
                        .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                            if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                                if this.workspace_state.read(cx).git_busy {
                                    return;
                                }
                                this.model_picker
                                    .update(cx, |picker, _| picker.close_rollback());
                                this.model_picker_input.update(cx, |input, cx| {
                                    input.set_value("", window, cx);
                                });
                                this.open_model_pad_settings(window, cx);
                                cx.stop_propagation();
                            }
                        }))
                        .child(
                            Button::new("composer-model-pad-customize")
                                .small()
                                .tab_stop(false)
                                .disabled(model_pad_settings_blocked)
                                .label("Customize Model Pad")
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.model_picker
                                        .update(cx, |picker, _| picker.close_rollback());
                                    this.model_picker_input.update(cx, |input, cx| {
                                        input.set_value("", window, cx);
                                    });
                                    this.open_model_pad_settings(window, cx);
                                })),
                        ),
                )
                .into_any_element()
        } else {
            let grid_size = model_grid_size(pad_items.len());
            let active_point = active.as_deref().and_then(|active| {
                pad_items
                    .iter()
                    .find(|(item, _, _)| item.value_key() == active)
                    .map(|(_, x, y)| ModelPoint { x: *x, y: *y })
            });
            let active_axes = active_point.map(|point| model_grid_axes(point, grid_size));
            let dots = (0..grid_size * grid_size)
                .map(|index| {
                    let column = index % grid_size;
                    let row = index / grid_size;
                    let highlighted = active_axes.is_some_and(|(active_column, active_row)| {
                        column == active_column || row == active_row
                    });
                    div()
                        .id(SharedString::from(format!("model-pad-dot-{index}")))
                        .absolute()
                        .left(gpui::relative(model_grid_coordinate(column, grid_size)))
                        .top(gpui::relative(model_grid_coordinate(row, grid_size)))
                        .size(px(4.))
                        .ml(px(-2.))
                        .mt(px(-2.))
                        .rounded_full()
                        .bg(cx
                            .theme()
                            .foreground
                            .opacity(if highlighted { 0.50 } else { 0.16 }))
                })
                .collect::<Vec<_>>();
            let pad = div()
                .relative()
                .h(px(MODEL_PAD_SURFACE_SIZE_PX))
                .w_full()
                .track_focus(&self.model_picker_pad_focus)
                .tab_stop(true)
                .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                    let key = match event.keystroke.key.as_str() {
                        "left" => Some(ModelPadKey::Arrow(ModelDirection::Left)),
                        "right" => Some(ModelPadKey::Arrow(ModelDirection::Right)),
                        "up" => Some(ModelPadKey::Arrow(ModelDirection::Up)),
                        "down" => Some(ModelPadKey::Arrow(ModelDirection::Down)),
                        "enter" => Some(ModelPadKey::Enter),
                        "space" => Some(ModelPadKey::Space),
                        _ => None,
                    };
                    let Some(key) = key else {
                        return;
                    };
                    if matches!(key, ModelPadKey::Enter | ModelPadKey::Space)
                        && this.service.read(cx).generation_active()
                    {
                        return;
                    }
                    let committed = this.model_picker.update(cx, |picker, cx| {
                        let committed = picker.pad_key(key);
                        cx.notify();
                        committed
                    });
                    if let Some(ComposerModelPickerEvent::Commit { provider_id, model }) = committed
                    {
                        this.service.update(cx, |service, cx| {
                            service.select_model(&provider_id, &model, cx)
                        });
                        this.model_picker_input
                            .update(cx, |input, cx| input.set_value("", window, cx));
                        this.model_picker_trigger_focus.focus(window);
                    }
                    cx.stop_propagation();
                }))
                .rounded_lg()
                .bg(cx.theme().background)
                .border_1()
                .border_color(cx.theme().border)
                .child(
                    div()
                        .absolute()
                        .left(gpui::relative(0.5))
                        .top(gpui::relative(0.5))
                        .size(px(8.))
                        .ml(px(-4.))
                        .mt(px(-4.))
                        .rounded_full()
                        .border_1()
                        .border_color(cx.theme().foreground.opacity(0.25)),
                )
                .child(BoundsAwarePadSurface::new("composer-model-pad-surface", {
                    let picker = self.model_picker.clone();
                    let service = self.service.clone();
                    let input = self.model_picker_input.clone();
                    let trigger_focus = self.model_picker_trigger_focus.clone();
                    move |event, window, cx| match event {
                        PadPointerEvent::Down(point) => {
                            picker.update(cx, |picker, cx| {
                                picker.pad_down(point);
                                cx.notify();
                            });
                        }
                        PadPointerEvent::Move(point) => {
                            let schedule = picker.update(cx, |picker, _cx| picker.pad_move(point));
                            if schedule {
                                let picker = picker.clone();
                                window.on_next_frame(move |_window, cx| {
                                    picker.update(cx, |picker, cx| {
                                        picker.flush_pad_frame();
                                        cx.notify();
                                    });
                                });
                            }
                        }
                        PadPointerEvent::Up(point) => {
                            if service.read(cx).generation_active() {
                                return;
                            }
                            let event = picker.update(cx, |picker, _cx| picker.pad_up(point));
                            if let Some(ComposerModelPickerEvent::Commit { provider_id, model }) =
                                event
                            {
                                service.update(cx, |service, cx| {
                                    service.select_model(&provider_id, &model, cx);
                                });
                                input.update(cx, |input, cx| input.set_value("", window, cx));
                                trigger_focus.focus(window);
                            }
                        }
                        PadPointerEvent::Leave => picker.update(cx, |picker, cx| {
                            picker.pad_leave();
                            cx.notify();
                        }),
                        PadPointerEvent::Cancel => picker.update(cx, |picker, cx| {
                            picker.pad_cancel();
                            cx.notify();
                        }),
                    }
                }))
                .children(dots)
                .children(pad_items.iter().map(|(item, x, y)| {
                    let key = item.value_key();
                    let is_active = active.as_deref() == Some(key.as_str());
                    let is_selected = selection.as_deref() == Some(key.as_str());
                    div()
                        .id(SharedString::from(format!("model-pad-model-{key}")))
                        .absolute()
                        .left(gpui::relative(0.07 + *x as f32 * 0.86))
                        .top(gpui::relative(0.07 + (1. - *y as f32) * 0.86))
                        .size(px(MODEL_PAD_POINT_SIZE_PX))
                        .ml(px(-MODEL_PAD_POINT_SIZE_PX / 2.))
                        .mt(px(-MODEL_PAD_POINT_SIZE_PX / 2.))
                        .rounded_full()
                        .border_1()
                        .border_color(cx.theme().popover.opacity(0.55))
                        .bg(if is_selected || is_active {
                            cx.theme().accent
                        } else {
                            cx.theme().foreground.opacity(0.45)
                        })
                }));
            pad.when_some(active_point, |pad, point| {
                pad.child(
                    div()
                        .id("model-pad-active-puck")
                        .absolute()
                        .left(gpui::relative(0.07 + point.x as f32 * 0.86))
                        .top(gpui::relative(0.07 + (1. - point.y as f32) * 0.86))
                        .size(px(MODEL_PAD_PUCK_SIZE_PX))
                        .ml(px(-MODEL_PAD_PUCK_SIZE_PX / 2.))
                        .mt(px(-MODEL_PAD_PUCK_SIZE_PX / 2.))
                        .rounded_full()
                        .bg(gpui::white())
                        .border_1()
                        .border_color(gpui::black().opacity(0.20))
                        .shadow_md(),
                )
            })
            .into_any_element()
        };
        let show_external_details = window.viewport_size().width.as_f64() >= 620.;
        let uses_artificial_analysis = runtime.as_ref().is_some_and(|runtime| {
            runtime.layout.placements.values().any(|placement| {
                placement.source
                    == aiden_core::model_pad::ModelPadPlacementSource::ArtificialAnalysis
            })
        });
        let picker_surface = v_flex()
            .id("composer-model-picker-popover")
            .w(px(MODEL_PICKER_WIDTH_PX))
            .max_h(px(420.))
            .overflow_y_scroll()
            .rounded_lg()
            .bg(cx.theme().popover)
            .border_1()
            .border_color(cx.theme().border)
            .shadow_md()
            .p_2()
            .child(
                h_flex()
                    .gap_1()
                    .child(
                        Button::new("composer-model-picker-list")
                            .ghost()
                            .small()
                            .label("List")
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.model_picker.update(cx, |picker, cx| {
                                    picker.tab = PickerTab::List;
                                    cx.notify();
                                });
                                this.model_picker_input
                                    .update(cx, |input, cx| input.focus(window, cx));
                            })),
                    )
                    .child(
                        Button::new("composer-model-picker-pad")
                            .ghost()
                            .small()
                            .label("Pad")
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.model_picker.update(cx, |picker, cx| {
                                    picker.activate_pad_tab();
                                    cx.notify();
                                });
                                if pad_has_positioned_models {
                                    this.model_picker_pad_focus.focus(window);
                                } else {
                                    this.model_picker_empty_pad_focus.focus(window);
                                }
                            })),
                    ),
            )
            .when(tab == PickerTab::List, |el| {
                el.child(Input::new(&self.model_picker_input).small())
            })
            .child(if tab == PickerTab::Pad {
                pad
            } else {
                let roving_pins = pinned.clone();
                v_flex()
                    .track_focus(&self.model_picker_focus)
                    .tab_stop(true)
                    .on_key_down(cx.listener(
                        move |this, event: &gpui::KeyDownEvent, window, cx| {
                            let key = event.keystroke.key.as_str();
                            if keyboard_toggles_active_pin(key, event.keystroke.modifiers.platform)
                            {
                                if let Some(active) = this.model_picker.read(cx).active.clone() {
                                    let pins = cx.default_global::<ModelPickerPins>();
                                    pins.toggle(active);
                                    let snapshot = pins.clone();
                                    let store = this.stores.config.clone();
                                    cx.background_spawn(async move { snapshot.persist(&store) })
                                        .detach();
                                    cx.notify();
                                }
                                cx.stop_propagation();
                                return;
                            }
                            if key == "enter" && this.service.read(cx).generation_active() {
                                return;
                            }
                            let commit = this.model_picker.update(cx, |picker, cx| {
                                match key {
                                    "up" => picker.rove_visible_with_pins(-1, &roving_pins),
                                    "down" => picker.rove_visible_with_pins(1, &roving_pins),
                                    "home" => picker.rove_home_with_pins(&roving_pins),
                                    "end" => picker.rove_end_with_pins(&roving_pins),
                                    "enter" => {
                                        let active = picker.active.clone();
                                        let event =
                                            active.as_deref().and_then(|key| picker.commit(key));
                                        if event.is_some() {
                                            cx.notify();
                                        }
                                        return event;
                                    }
                                    _ => return None,
                                }
                                cx.notify();
                                None
                            });
                            if let Some(ComposerModelPickerEvent::Commit { provider_id, model }) =
                                commit
                            {
                                this.service.update(cx, |service, cx| {
                                    service.select_model(&provider_id, &model, cx);
                                });
                                this.model_picker_input
                                    .update(cx, |input, cx| input.set_value("", window, cx));
                                this.model_picker_trigger_focus.focus(window);
                            }
                            if matches!(key, "up" | "down" | "home" | "end" | "enter") {
                                cx.stop_propagation();
                            }
                        },
                    ))
                    .gap_1()
                    .children(items.into_iter().map(|item| {
                        let key = item.value_key();
                        let commit_key = key.clone();
                        let selected = selection.as_deref() == Some(key.as_str());
                        let is_active = active.as_deref() == Some(key.as_str());
                        let row_state = model_row_visual_state(is_active, selected);
                        let is_pinned = pinned.contains(&key);
                        let discovered = if item.discovered {
                            " · Discovered"
                        } else {
                            ""
                        };
                        h_flex()
                            .w_full()
                            .gap_1()
                            .rounded_md()
                            .bg(match row_state {
                                ModelRowVisualState::Selected => cx.theme().accent.opacity(0.10),
                                ModelRowVisualState::Active => cx.theme().list_active.opacity(0.55),
                                ModelRowVisualState::Default => cx.theme().transparent,
                            })
                            .child(
                                Button::new(SharedString::from(format!("composer-model-{key}")))
                                    .ghost()
                                    .small()
                                    .tab_stop(false)
                                    .flex_1()
                                    .w_full()
                                    .justify_start()
                                    .icon(model_provider_icon(&item))
                                    .label(format!(
                                        "{}{}",
                                        model_picker_item_summary(&item),
                                        discovered
                                    ))
                                    .on_hover({
                                        let key = key.clone();
                                        let picker = self.model_picker.clone();
                                        move |hovered, _, cx| {
                                            if *hovered {
                                                picker.update(cx, |picker, cx| {
                                                    picker.preview(key.clone());
                                                    cx.notify();
                                                });
                                            }
                                        }
                                    })
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        if this.service.read(cx).generation_active() {
                                            return;
                                        }
                                        let event = this
                                            .model_picker
                                            .update(cx, |picker, _cx| picker.commit(&commit_key));
                                        if let Some(ComposerModelPickerEvent::Commit {
                                            provider_id,
                                            model,
                                        }) = event
                                        {
                                            this.service.update(cx, |service, cx| {
                                                service.select_model(&provider_id, &model, cx)
                                            });
                                            this.model_picker_input.update(cx, |input, cx| {
                                                input.set_value("", window, cx)
                                            });
                                            this.model_picker_trigger_focus.focus(window);
                                        }
                                    })),
                            )
                            .when(selected, |row| {
                                row.child(
                                    Icon::new(IconName::Check)
                                        .xsmall()
                                        .text_color(cx.theme().accent),
                                )
                            })
                            .child(
                                Button::new(SharedString::from(format!(
                                    "composer-model-pin-{key}"
                                )))
                                .ghost()
                                .small()
                                .tab_stop(false)
                                .icon(if is_pinned {
                                    IconName::StarOff
                                } else {
                                    IconName::Star
                                })
                                .tooltip(if is_pinned {
                                    "Unpin model"
                                } else {
                                    "Pin model"
                                })
                                .on_click(cx.listener(
                                    move |this, _, _, cx| {
                                        let pins = cx.default_global::<ModelPickerPins>();
                                        pins.toggle(key.clone());
                                        let snapshot = pins.clone();
                                        let store = this.stores.config.clone();
                                        cx.background_spawn(
                                            async move { snapshot.persist(&store) },
                                        )
                                        .detach();
                                        cx.notify();
                                    },
                                )),
                            )
                    }))
                    .into_any_element()
            })
            .when(
                !show_external_details && uses_artificial_analysis,
                |picker| {
                    picker.child(
                        h_flex()
                            .border_t_1()
                            .border_color(cx.theme().border)
                            .pt_1()
                            .child(
                                Button::new("composer-model-picker-aa-footer")
                                    .link()
                                    .small()
                                    .icon(IconName::ExternalLink)
                                    .label("Model data · Artificial Analysis")
                                    .on_click(|_, _, cx| {
                                        cx.open_url("https://artificialanalysis.ai")
                                    }),
                            ),
                    )
                },
            );
        let detail = if show_external_details {
            let active_item = self
                .model_picker
                .read(cx)
                .active
                .as_deref()
                .and_then(|key| {
                    self.model_picker
                        .read(cx)
                        .items
                        .iter()
                        .find(|item| item.value_key() == key)
                        .cloned()
                });
            active_item.map(|item| {
                let details = model_detail_lines(&item);
                let artificial_analysis = uses_artificial_analysis;
                div()
                    .absolute()
                    .left(px(model_picker_detail_left(0.0)))
                    .top_0()
                    .w(px(MODEL_PICKER_DETAIL_WIDTH_PX))
                    .rounded_lg()
                    .bg(cx.theme().popover)
                    .border_1()
                    .border_color(cx.theme().border)
                    .shadow_md()
                    .p_3()
                    .child(
                        h_flex()
                            .items_start()
                            .gap_2()
                            .child(
                                model_provider_icon(&item)
                                    .small()
                                    .text_color(cx.theme().muted_foreground),
                            )
                            .child(
                                v_flex()
                                    .min_w(px(0.))
                                    .child(
                                        div()
                                            .text_sm()
                                            .child(model_display_name(&item).to_string()),
                                    )
                                    .child(
                                        div()
                                            .text_xs()
                                            .text_color(cx.theme().muted_foreground)
                                            .child(format!(
                                                "{} · {}",
                                                item.provider_label,
                                                deployment_label(&item)
                                            )),
                                    ),
                            ),
                    )
                    .child(
                        v_flex()
                            .mt_2()
                            .gap_1()
                            .children(details.into_iter().map(|detail| {
                                div()
                                    .text_xs()
                                    .text_color(cx.theme().muted_foreground)
                                    .child(detail)
                            }))
                            .when(artificial_analysis, |el| {
                                el.child(
                                    Button::new("composer-model-picker-aa-detail")
                                        .link()
                                        .small()
                                        .icon(IconName::ExternalLink)
                                        .label("Model data · Artificial Analysis")
                                        .on_click(|_, _, cx| {
                                            cx.open_url("https://artificialanalysis.ai")
                                        }),
                                )
                            }),
                    )
            })
        } else {
            None
        };
        let has_detail = detail.is_some();
        let (popover_width, popover_right) = model_picker_shell_geometry(has_detail);
        let popover_shell = div()
            .absolute()
            .right(px(popover_right))
            .bottom(px(34.))
            .w(px(popover_width))
            .occlude()
            .on_mouse_down_out(cx.listener(|this, _, window, cx| {
                this.model_picker
                    .update(cx, |picker, _| picker.close_rollback());
                this.model_picker_input
                    .update(cx, |input, cx| input.set_value("", window, cx));
                this.model_picker_trigger_focus.focus(window);
                cx.stop_propagation();
                cx.notify();
            }))
            .child(picker_surface)
            .when_some(detail, |shell, detail| shell.child(detail));
        div()
            .relative()
            .on_key_down(
                cx.listener(move |this, event: &gpui::KeyDownEvent, window, cx| {
                    let key = event.keystroke.key.as_str();
                    if key == "escape" {
                        let closed = this.model_picker.update(cx, |picker, cx| {
                            let closed = picker.escape();
                            cx.notify();
                            closed
                        });
                        if closed {
                            this.model_picker_input
                                .update(cx, |input, cx| input.set_value("", window, cx));
                            this.model_picker_trigger_focus.focus(window);
                        }
                        cx.stop_propagation();
                        return;
                    }
                    if tab != PickerTab::List
                        || !matches!(key, "up" | "down" | "home" | "end" | "enter")
                    {
                        return;
                    }
                    if key == "enter" && this.service.read(cx).generation_active() {
                        cx.stop_propagation();
                        return;
                    }
                    let event = this.model_picker.update(cx, |picker, cx| {
                        match key {
                            "up" => picker.rove_visible_with_pins(-1, &pinned),
                            "down" => picker.rove_visible_with_pins(1, &pinned),
                            "home" => picker.rove_home_with_pins(&pinned),
                            "end" => picker.rove_end_with_pins(&pinned),
                            "enter" => {
                                let active = picker.active.clone();
                                return active.as_deref().and_then(|key| picker.commit(key));
                            }
                            _ => {}
                        }
                        cx.notify();
                        None
                    });
                    if let Some(ComposerModelPickerEvent::Commit { provider_id, model }) = event {
                        this.service.update(cx, |service, cx| {
                            service.select_model(&provider_id, &model, cx)
                        });
                        this.model_picker_input
                            .update(cx, |input, cx| input.set_value("", window, cx));
                        this.model_picker_trigger_focus.focus(window);
                    } else {
                        this.model_picker_focus.focus(window);
                    }
                    cx.stop_propagation();
                }),
            )
            .child(trigger)
            .child(popover_shell)
            .into_any_element()
    }

    /// The attach (paperclip/plus) button: opens the macOS file picker filtered
    /// to images. Disabled while a generation is in flight or a picker read is
    /// pending.
    fn attach_button(
        &self,
        draft: &ComposerDraft,
        generating: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let disabled = generating || draft.attaching;
        if draft.attaching {
            return Button::new("composer-attach")
                .small()
                .ghost()
                .icon(IconName::Loader)
                .disabled(true)
                .tooltip("Reading attachment…")
                .into_any_element();
        }
        Button::new("composer-attach")
            .small()
            .ghost()
            .icon(IconName::Plus)
            .disabled(disabled)
            .tooltip("Attach images (⌘V to paste)")
            .on_click(cx.listener(|this, _event, window, cx| {
                this.attach_images(window, cx);
            }))
            .into_any_element()
    }

    /// Staged-attachment thumbnails, shown above the composer input.
    fn attachment_row(&self, draft: &ComposerDraft, cx: &mut Context<Self>) -> impl IntoElement {
        h_flex()
            .id("composer-attachments")
            .w_full()
            .gap_2()
            .flex_wrap()
            .px_1p5()
            .pt_1()
            .children(
                draft
                    .attachments
                    .iter()
                    .map(|attachment| self.attachment_chip(attachment, cx)),
            )
    }

    /// One thumbnail chip: small image preview (or file icon fallback), name,
    /// size, and a remove button.
    fn attachment_chip(&self, attachment: &Attachment, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let id = attachment.id.clone();
        let name = attachment.name.clone();
        let size = format_bytes(attachment.size);
        h_flex()
            .id(ElementId::Name(SharedString::from(format!(
                "attachment-{id}"
            ))))
            .gap_1p5()
            .items_center()
            .px_1p5()
            .py_1()
            .rounded_md()
            .bg(theme.muted)
            .border_1()
            .border_color(theme.border)
            .child(
                attachment_image_element(attachment, 40.0).unwrap_or_else(|| {
                    Icon::new(IconName::File)
                        .small()
                        .text_color(theme.muted_foreground)
                        .into_any_element()
                }),
            )
            .child(div().max_w(px(160.)).truncate().text_xs().child(name))
            .child(
                div()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .child(size),
            )
            .child(
                Button::new(ElementId::Name(SharedString::from(format!(
                    "remove-attachment-{id}"
                ))))
                .small()
                .ghost()
                .icon(IconName::Close)
                .tooltip("Remove attachment")
                .on_click(cx.listener(move |this, _event, _window, cx| {
                    this.remove_attachment(&id, cx);
                })),
            )
    }

    /// The "Editing message" banner with a cancel affordance, shown above the
    /// input while the user is editing a prior message.
    fn editing_banner(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let accent = theme.accent;
        h_flex()
            .id("composer-editing")
            .w_full()
            .gap_1()
            .items_center()
            .px_1p5()
            .child(Icon::new(IconName::Replace).small().text_color(accent))
            .child(div().text_xs().text_color(accent).child("Editing message"))
            .child(div().flex_1())
            .child(
                Button::new("cancel-edit")
                    .small()
                    .ghost()
                    .icon(IconName::Close)
                    .tooltip("Cancel editing")
                    .on_click(cx.listener(|this, _event, _window, cx| {
                        this.cancel_edit(cx);
                    })),
            )
    }

    // =======================================================================
    // Composer actions
    // =======================================================================

    /// Open the macOS file picker (images only), read + validate the picks on
    /// the background executor, and stage them in the composer draft. Rejected
    /// files surface a notification naming the file.
    pub(crate) fn attach_images(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.service.read(cx).generation_active() {
            return;
        }
        let receiver = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some(SharedString::from("Attach images")),
        });
        composer_draft(cx).attaching = true;
        cx.notify();
        let window_handle = window.window_handle();
        cx.spawn(async move |this, cx| {
            let picked = match receiver.await {
                Ok(Ok(Some(paths))) => paths,
                _ => Vec::new(),
            };
            if picked.is_empty() {
                let _ = this.update(cx, |_this, cx| {
                    composer_draft(cx).attaching = false;
                    cx.notify();
                });
                return;
            }
            let loaded: Vec<(PathBuf, Result<Attachment, AttachmentError>)> = cx
                .background_spawn(async move {
                    picked
                        .into_iter()
                        .map(|path| {
                            let outcome = read_image_attachment(&path);
                            (path, outcome)
                        })
                        .collect()
                })
                .await;
            let _ = this.update(cx, |_this, cx| {
                composer_draft(cx).attaching = false;
                let mut added = 0;
                for (path, outcome) in loaded {
                    match outcome {
                        Ok(attachment) => {
                            if composer_draft(cx).add_attachment(attachment) {
                                added += 1;
                            }
                        }
                        Err(error) => {
                            let name = path
                                .file_name()
                                .map(|name| name.to_string_lossy().into_owned())
                                .unwrap_or_else(|| path.display().to_string());
                            let _ = window_handle.update(cx, |_view, window, cx| {
                                window.push_notification(
                                    Notification::error(format!("{name} {error}")),
                                    cx,
                                );
                            });
                        }
                    }
                }
                if added > 0 {
                    cx.notify();
                }
            });
        })
        .detach();
    }

    /// Intercept ⌘V: when the clipboard carries an image, stage it as an
    /// attachment instead of letting the input paste empty text. Returns `true`
    /// when an image was staged (the caller then stops propagation so the
    /// input's text-paste never runs for image clips).
    fn handle_paste_image(&mut self, cx: &mut Context<Self>) -> bool {
        if self.service.read(cx).generation_active() {
            return false;
        }
        let Some(item) = cx.read_from_clipboard() else {
            return false;
        };
        let Some(image) = item.entries().iter().find_map(|entry| match entry {
            gpui::ClipboardEntry::Image(image) => Some(image),
            _ => None,
        }) else {
            return false;
        };
        let bytes = image.bytes.clone();
        let mime = image.format.mime_type().to_string();
        if bytes.is_empty()
            || renderable_image_format(&mime).is_none()
            || bytes.len() as u64 > MAX_IMAGE_BYTES
        {
            return false;
        }
        let attachment = attachment_from_image_bytes(
            "pasted-image".to_string(),
            &mime,
            bytes.len() as u64,
            bytes,
        );
        let added = composer_draft(cx).add_attachment(attachment);
        if added {
            cx.notify();
        }
        added
    }

    /// Remove a staged attachment by id.
    fn remove_attachment(&mut self, id: &str, cx: &mut Context<Self>) {
        if composer_draft(cx).remove_attachment(id) {
            cx.notify();
        }
    }

    /// Leave edit mode without sending (the composer text is kept).
    fn cancel_edit(&mut self, cx: &mut Context<Self>) {
        composer_draft(cx).cancel_edit();
        cx.notify();
    }

    /// Send the composer contents (send button). Handles the edit rebranch:
    /// while editing, truncates the transcript back to (and including) the
    /// edited message — dropping every later message — then sends the edited
    /// text as a fresh turn. The staged attachments + edit target are cleared
    /// up front (mirroring `send_composer`'s clear-before-send).
    ///
    /// Note: the ⌘-Enter key path routes through `app.rs::send_composer` and
    /// sends text only; the edit rebranch + attachment staging apply to the
    /// send button.
    pub(crate) fn submit_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.composer_input.read(cx).value().to_string();
        let trimmed = text.trim().to_string();
        if trimmed.is_empty() {
            return;
        }
        // Don't clear if a generation is active — the send would be rejected
        // and the user's text would vanish.
        let is_active = self.service.read(cx).generation_active();
        if is_active {
            return;
        }

        let draft = composer_draft(cx).clone();
        self.composer_input
            .update(cx, |input, inner| input.set_value("", window, inner));
        composer_draft(cx).clear();

        // Route through send_message_with so the edit rebranch (truncation)
        // is persisted to the ChatStore — same path as the Enter key handler.
        self.service.update(cx, |service, cx| {
            service.send_message_with(&trimmed, draft.attachments, draft.editing_message_id, cx);
        });
    }
}

fn model_detail_lines(item: &crate::chat::composer::ModelItem) -> Vec<String> {
    let Some(metadata) = item.metadata.as_ref() else {
        return vec!["No cached capability metadata".into()];
    };
    let mut capabilities = Vec::new();
    if metadata.vision == Some(true) {
        capabilities.push("Vision");
    }
    if metadata.tool_call == Some(true) {
        capabilities.push("Tools");
    }
    if metadata.reasoning == Some(true) {
        capabilities.push("Reasoning");
    }
    let mut lines = Vec::new();
    if !capabilities.is_empty() {
        lines.push(capabilities.join(" · "));
    }
    if let Some(context) = metadata.context_length {
        lines.push(format!("{}K context", context / 1_000));
    }
    if let Some(parameters) = metadata.parameter_count.as_deref() {
        lines.push(format!("{parameters} parameters"));
    }
    if let Some(format) = metadata.format.as_deref() {
        lines.push(format!("Format: {format}"));
    }
    if lines.is_empty() {
        lines.push("Cached provider metadata".into());
    }
    lines
}

const fn model_picker_trigger_enabled(disabled: bool, item_count: usize) -> bool {
    !disabled && item_count > 0
}

fn keyboard_toggles_active_pin(key: &str, platform_modifier: bool) -> bool {
    platform_modifier && key == "p"
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ModelRowVisualState {
    Default,
    Active,
    Selected,
}

const fn model_row_visual_state(active: bool, selected: bool) -> ModelRowVisualState {
    if selected {
        ModelRowVisualState::Selected
    } else if active {
        ModelRowVisualState::Active
    } else {
        ModelRowVisualState::Default
    }
}

fn model_display_name(item: &crate::chat::composer::ModelItem) -> &str {
    item.metadata
        .as_ref()
        .and_then(|metadata| metadata.name.as_deref())
        .unwrap_or(&item.model)
}

const fn deployment_label(item: &crate::chat::composer::ModelItem) -> &'static str {
    if item.local {
        "Local"
    } else {
        "Hosted"
    }
}

fn model_picker_item_summary(item: &crate::chat::composer::ModelItem) -> String {
    format!(
        "{} · {} · {}",
        model_display_name(item),
        item.provider_label,
        deployment_label(item)
    )
}

const MODEL_PICKER_WIDTH_PX: f32 = 316.0;
const MODEL_PICKER_DETAIL_GAP_PX: f32 = 8.0;
const MODEL_PICKER_DETAIL_WIDTH_PX: f32 = 224.0;
const MODEL_PAD_POINT_SIZE_PX: f32 = 6.0;
const MODEL_PAD_PUCK_SIZE_PX: f32 = 24.0;
const MODEL_PAD_SURFACE_SIZE_PX: f32 = 300.0;

const fn model_picker_detail_left(picker_left: f32) -> f32 {
    picker_left + MODEL_PICKER_WIDTH_PX + MODEL_PICKER_DETAIL_GAP_PX
}

const fn model_picker_shell_geometry(has_detail: bool) -> (f32, f32) {
    if has_detail {
        (
            MODEL_PICKER_WIDTH_PX + MODEL_PICKER_DETAIL_GAP_PX + MODEL_PICKER_DETAIL_WIDTH_PX,
            -(MODEL_PICKER_DETAIL_WIDTH_PX + MODEL_PICKER_DETAIL_GAP_PX),
        )
    } else {
        (MODEL_PICKER_WIDTH_PX, 0.0)
    }
}

fn provider_icon_asset_path(provider_id: &str, model_id: &str) -> Option<&'static str> {
    let provider_id = provider_id.trim().to_ascii_lowercase();
    let model_id = model_id.trim().to_ascii_lowercase();
    let slug = match provider_id.as_str() {
        "anthropic" if model_id.contains("claude") => "claude",
        "xai" if model_id.contains("grok") => "grok",
        "custom:lmstudio" | "lm-studio" => "lmstudio",
        "custom:ollama" => "ollama",
        "gemini" => "google",
        "moonshot" => "moonshotai",
        "amazon-bedrock"
        | "ant-ling"
        | "anthropic"
        | "apple-foundation-models"
        | "azure-openai-responses"
        | "cerebras"
        | "claude"
        | "cloudflare-ai-gateway"
        | "cloudflare-workers-ai"
        | "deepseek"
        | "fireworks"
        | "github-copilot"
        | "google"
        | "google-vertex"
        | "grok"
        | "groq"
        | "huggingface"
        | "kimi-coding"
        | "lmstudio"
        | "minimax"
        | "minimax-cn"
        | "mistral"
        | "moonshotai"
        | "moonshotai-cn"
        | "nvidia"
        | "ollama"
        | "openai"
        | "openai-codex"
        | "opencode"
        | "opencode-go"
        | "openrouter"
        | "together"
        | "vercel-ai-gateway"
        | "xai"
        | "xiaomi"
        | "xiaomi-token-plan-ams"
        | "xiaomi-token-plan-cn"
        | "xiaomi-token-plan-sgp"
        | "zai"
        | "zai-coding-cn" => provider_id.as_str(),
        _ => return None,
    };
    Some(match slug {
        "amazon-bedrock" => "provider-logos/amazon-bedrock.svg",
        "ant-ling" => "provider-logos/ant-ling.svg",
        "anthropic" => "provider-logos/anthropic.svg",
        "apple-foundation-models" => "provider-logos/apple-foundation-models.svg",
        "azure-openai-responses" => "provider-logos/azure-openai-responses.svg",
        "cerebras" => "provider-logos/cerebras.svg",
        "claude" => "provider-logos/claude.svg",
        "cloudflare-ai-gateway" => "provider-logos/cloudflare-ai-gateway.svg",
        "cloudflare-workers-ai" => "provider-logos/cloudflare-workers-ai.svg",
        "deepseek" => "provider-logos/deepseek.svg",
        "fireworks" => "provider-logos/fireworks.svg",
        "github-copilot" => "provider-logos/github-copilot.svg",
        "google" => "provider-logos/google.svg",
        "google-vertex" => "provider-logos/google-vertex.svg",
        "grok" => "provider-logos/grok.svg",
        "groq" => "provider-logos/groq.svg",
        "huggingface" => "provider-logos/huggingface.svg",
        "kimi-coding" => "provider-logos/kimi-coding.svg",
        "lmstudio" => "provider-logos/lmstudio.svg",
        "mistral" => "provider-logos/mistral.svg",
        "minimax" => "provider-logos/minimax.svg",
        "minimax-cn" => "provider-logos/minimax-cn.svg",
        "moonshotai" => "provider-logos/moonshotai.svg",
        "moonshotai-cn" => "provider-logos/moonshotai-cn.svg",
        "nvidia" => "provider-logos/nvidia.svg",
        "ollama" => "provider-logos/ollama.svg",
        "openai" => "provider-logos/openai.svg",
        "openai-codex" => "provider-logos/openai-codex.svg",
        "openrouter" => "provider-logos/openrouter.svg",
        "opencode" => "provider-logos/opencode.svg",
        "opencode-go" => "provider-logos/opencode-go.svg",
        "together" => "provider-logos/together.svg",
        "vercel-ai-gateway" => "provider-logos/vercel-ai-gateway.svg",
        "xai" => "provider-logos/xai.svg",
        "xiaomi" => "provider-logos/xiaomi.svg",
        "xiaomi-token-plan-ams" => "provider-logos/xiaomi-token-plan-ams.svg",
        "xiaomi-token-plan-cn" => "provider-logos/xiaomi-token-plan-cn.svg",
        "xiaomi-token-plan-sgp" => "provider-logos/xiaomi-token-plan-sgp.svg",
        "zai" => "provider-logos/zai.svg",
        "zai-coding-cn" => "provider-logos/zai-coding-cn.svg",
        _ => return None,
    })
}

fn model_provider_icon(item: &crate::chat::composer::ModelItem) -> Icon {
    if let Some(path) = provider_icon_asset_path(&item.provider_id, &item.model) {
        return Icon::default().path(path);
    }
    Icon::new(if item.local {
        IconName::SquareTerminal
    } else {
        IconName::Globe
    })
}

/// Minimal microphone glyph for the composer voice button. This avoids adding
/// a one-off asset source solely for an icon that gpui-component 0.5 omits.
fn microphone_glyph(color: gpui::Hsla) -> impl IntoElement {
    div()
        .relative()
        .size(px(14.))
        .child(
            div()
                .absolute()
                .top_0()
                .left(px(4.))
                .w(px(6.))
                .h(px(9.))
                .rounded_full()
                .border_1()
                .border_color(color),
        )
        .child(
            div()
                .absolute()
                .top(px(8.))
                .left(px(6.5))
                .w(px(1.))
                .h(px(4.))
                .bg(color),
        )
        .child(
            div()
                .absolute()
                .bottom_0()
                .left(px(3.))
                .w(px(8.))
                .h(px(1.))
                .bg(color),
        )
}

#[cfg(test)]
mod model_picker_surface_tests {
    use super::*;

    #[test]
    fn disabled_or_empty_trigger_has_no_keyboard_activation() {
        assert!(!model_picker_trigger_enabled(true, 3));
        assert!(!model_picker_trigger_enabled(false, 0));
        assert!(model_picker_trigger_enabled(false, 1));
    }

    #[test]
    fn detail_rail_is_offset_to_the_right_of_the_picker() {
        assert_eq!(model_picker_detail_left(20.0), 344.0);
        assert_eq!(MODEL_PICKER_DETAIL_WIDTH_PX, 224.0);
        assert_eq!(model_picker_shell_geometry(true), (548.0, -232.0));
        assert_eq!(model_picker_shell_geometry(false), (316.0, 0.0));

        // With the trigger's right edge as zero, the combined shell begins at
        // -316 and the detail begins at +8: trigger width cannot affect it.
        let (shell_width, shell_right) = model_picker_shell_geometry(true);
        let shell_left = -shell_right - shell_width;
        assert_eq!(shell_left + model_picker_detail_left(0.0), 8.0);
    }

    #[test]
    fn pin_shortcut_is_unambiguous() {
        assert_eq!(
            model_row_visual_state(true, false),
            ModelRowVisualState::Active
        );
        assert_eq!(
            model_row_visual_state(true, true),
            ModelRowVisualState::Selected
        );
        assert!(keyboard_toggles_active_pin("p", true));
        assert!(!keyboard_toggles_active_pin("p", false));
    }

    #[test]
    fn point_and_puck_remain_distinct_layers() {
        assert_eq!(MODEL_PAD_POINT_SIZE_PX, 6.0);
        assert_eq!(MODEL_PAD_PUCK_SIZE_PX, 24.0);
        assert_eq!(MODEL_PAD_SURFACE_SIZE_PX, 300.0);
    }

    #[test]
    fn provider_asset_resolution_handles_model_specific_and_local_aliases() {
        assert_eq!(
            provider_icon_asset_path("anthropic", "claude-sonnet"),
            Some("provider-logos/claude.svg")
        );
        assert_eq!(
            provider_icon_asset_path("custom:ollama", "llama"),
            Some("provider-logos/ollama.svg")
        );
        assert_eq!(provider_icon_asset_path("custom:other", "model"), None);

        let item = crate::chat::composer::ModelItem::test_item("anthropic", "claude-sonnet");
        assert_eq!(
            model_picker_item_summary(&item),
            "claude-sonnet · anthropic · Hosted"
        );
    }
}
