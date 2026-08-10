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
    div, prelude::FluentBuilder as _, px, AppContext as _, Context, ElementId,
    InteractiveElement as _, IntoElement, ParentElement as _, PathPromptOptions, SharedString,
    Styled as _, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{Input, Paste},
    notification::Notification,
    v_flex, ActiveTheme, Disableable as _, Icon, IconName, Sizable as _, WindowExt as _,
};

use crate::app::AppState;
use crate::chat::composer::{
    attachment_from_image_bytes, attachment_image_element, composer_draft, format_bytes,
    read_image_attachment, renderable_image_format, truncate_history_after, AttachmentError,
    ComposerDraft, MAX_IMAGE_BYTES,
};
use crate::chat::message_list::scroll_at_bottom;
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
            .child(self.workspace_bar(window, cx))
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
        _window: &mut Window,
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
                .border_color(theme.border)
                .shadow_md()
                .px_3()
                .py_2()
                .gap_1()
                .when(draft.has_attachments(), |el| {
                    el.child(self.attachment_row(&draft, cx))
                })
                .when(draft.is_editing(), |el| el.child(self.editing_banner(cx)))
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
                            h_flex()
                                .gap_1()
                                .items_center()
                                .child(self.attach_button(&draft, generating, cx))
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
        )
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
