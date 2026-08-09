//! Composer support: the model-picker items (shared by the sidebar footer and
//! the composer), the pending-attachment draft + edit state machine, the
//! attachment read/validate helpers (a port of `main/services/attachments.ts`
//! for images), and the edit-rebranch truncation helper. The interactive
//! composer itself is rendered from `AppState` (see `chat_pane.rs`).

use std::path::Path;
use std::sync::Arc;

use aiden_core::{Attachment, AttachmentKind, ChatMessage};
use aiden_data::chat_store::new_uuid_like;
use base64::Engine as _;
use gpui::{
    div, prelude::FluentBuilder as _, App, Entity, IntoElement, ParentElement as _, SharedString,
    Styled as _, StyledImage as _, Window,
};
use gpui_component::{
    h_flex,
    select::{Select, SelectItem, SelectState},
    v_flex, ActiveTheme, Sizable as _,
};

use crate::services::provider_kit::ConfiguredProvider;

/// One model choice in the picker: provider + model. The `SelectItem::Value`
/// is a compact key so duplicate model ids across providers stay distinct.
#[derive(Debug, Clone)]
pub struct ModelItem {
    pub provider_label: String,
    pub model: String,
    /// The model was contributed by the models.dev capability catalog (not a
    /// provider preset); the picker renders it with a "discovered" badge.
    pub discovered: bool,
    value_key: String,
}

impl SelectItem for ModelItem {
    type Value = String;

    fn title(&self) -> SharedString {
        format!("{} · {}", self.provider_label, self.model).into()
    }

    fn value(&self) -> &Self::Value {
        &self.value_key
    }

    fn render(&self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = cx.theme();
        let accent = theme.accent;
        let model = self.model.clone();
        let provider_label = self.provider_label.clone();
        v_flex()
            .gap_0p5()
            .child(
                h_flex()
                    .gap_1()
                    .items_center()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(gpui::FontWeight::MEDIUM)
                            .child(model),
                    )
                    .when(self.discovered, |el| {
                        el.child(
                            div()
                                .px_1()
                                .py_0p5()
                                .rounded_sm()
                                .bg(accent.opacity(0.14))
                                .text_xs()
                                .text_color(accent)
                                .child("discovered"),
                        )
                    }),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child(provider_label),
            )
    }
}

/// Encode a selection into the picker's value key.
pub fn model_key(provider_id: &str, model: &str) -> String {
    format!("{provider_id}\u{0}{model}")
}

/// Decode a picker value key back into provider id + model.
pub fn decode_model_key(key: &str) -> Option<(String, String)> {
    let (provider_id, model) = key.split_once('\u{0}')?;
    if provider_id.is_empty() || model.is_empty() {
        return None;
    }
    Some((provider_id.to_string(), model.to_string()))
}

/// Build the picker items from the configured providers. Catalog-sourced
/// models (appended to `provider.models` by the boot enrichment) render with
/// the "discovered" badge; preset/default models do not.
pub fn model_items(providers: &[ConfiguredProvider]) -> Vec<ModelItem> {
    providers
        .iter()
        .flat_map(|provider| {
            let mut models = provider.models.clone();
            if let Some(default) = &provider.default_model {
                if !models.contains(default) {
                    models.insert(0, default.clone());
                }
            }
            models.into_iter().map(move |model| ModelItem {
                provider_label: provider.label.clone(),
                value_key: model_key(&provider.id, &model),
                discovered: provider.catalog_models.contains(&model),
                model,
            })
        })
        .collect()
}

/// The model picker select element (rendered in the sidebar footer).
pub fn model_picker(
    state: &Entity<SelectState<Vec<ModelItem>>>,
    disabled: bool,
) -> Select<Vec<ModelItem>> {
    Select::new(state)
        .placeholder("Model")
        .search_placeholder("Search models")
        .disabled(disabled)
        .small()
        .menu_width(gpui::px(240.))
}

// ===========================================================================
// Composer draft: pending attachments + edit target
// ===========================================================================

/// Max image bytes accepted for an attachment, mirroring `attachments.ts`
/// (`MAX_IMAGE_BYTES = 8 MB`).
pub const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;

/// The pending composer state: attachments staged before send, the message id
/// being edited (if any), and whether a file picker read is in flight. Lives in
/// a GPUI `Global` so both the composer (`chat_pane.rs`) and the transcript
/// hover actions (`message_list.rs`) can read and mutate it without threading
/// an entity through `AppState`.
#[derive(Debug, Clone, Default)]
pub struct ComposerDraft {
    /// Staged image attachments (base64 `data`), shown as thumbnails above the
    /// input and cleared on send.
    pub attachments: Vec<Attachment>,
    /// The id of the user message being edited. While set, sending truncates
    /// the transcript back to (and including) this message and re-sends the
    /// edited text, rebranching the conversation.
    pub editing_message_id: Option<String>,
    /// Whether a file-picker read is in flight (spinner/disabled attach button).
    pub attaching: bool,
}

impl gpui::Global for ComposerDraft {}

impl ComposerDraft {
    /// Stage an attachment. Returns `false` when an attachment with the same id
    /// is already staged (no duplicates).
    pub fn add_attachment(&mut self, attachment: Attachment) -> bool {
        if self
            .attachments
            .iter()
            .any(|existing| existing.id == attachment.id)
        {
            return false;
        }
        self.attachments.push(attachment);
        true
    }

    /// Remove a staged attachment by id; `true` when something was removed.
    pub fn remove_attachment(&mut self, id: &str) -> bool {
        let before = self.attachments.len();
        self.attachments.retain(|attachment| attachment.id != id);
        before != self.attachments.len()
    }

    /// Enter edit mode for the given message id (the composer text is loaded by
    /// the caller).
    pub fn begin_edit(&mut self, message_id: String) {
        self.editing_message_id = Some(message_id);
    }

    /// Leave edit mode without sending (the user's composer text is kept).
    pub fn cancel_edit(&mut self) {
        self.editing_message_id = None;
    }

    pub fn is_editing(&self) -> bool {
        self.editing_message_id.is_some()
    }

    pub fn has_attachments(&self) -> bool {
        !self.attachments.is_empty()
    }

    /// Reset the draft after a send: drop staged attachments and any edit
    /// target.
    pub fn clear(&mut self) {
        self.attachments.clear();
        self.editing_message_id = None;
    }
}

/// Access the app-wide composer draft (auto-initialized to the default).
pub fn composer_draft(cx: &mut App) -> &mut ComposerDraft {
    cx.default_global::<ComposerDraft>()
}

// ===========================================================================
// Attachment reading + validation (port of `main/services/attachments.ts`)
// ===========================================================================

/// The image extensions the attach affordance accepts, mapped to mime types
/// (the same set `attachments.ts` exposes; `heic`/`heif`/`bmp` are omitted
/// because GPUI cannot render or the provider path does not carry them).
pub fn image_mime_for_path(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// Why an attachment was rejected by [`validate_image_attachment`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttachmentError {
    /// The path is not one of the accepted image extensions.
    NotAnImage,
    /// The file exceeds [`MAX_IMAGE_BYTES`].
    TooLarge(u64),
    /// The file could not be read (I/O failure, not a regular file, …).
    Unreadable(String),
}

impl std::fmt::Display for AttachmentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AttachmentError::NotAnImage => {
                write!(f, "isn't a supported image (png, jpg, gif, webp)")
            }
            AttachmentError::TooLarge(size) => write!(
                f,
                "is too large to attach (max 8 MB, got {:.1} MB)",
                *size as f64 / (1024.0 * 1024.0)
            ),
            AttachmentError::Unreadable(message) => write!(f, "couldn't be read: {message}"),
        }
    }
}

/// Validate a picked path and its size against the attach rules: the path must
/// be a supported image extension and the size must fit [`MAX_IMAGE_BYTES`].
/// Returns the resolved mime type on success. Pure — callers feed it
/// `fs::metadata` output, so the check is unit-testable.
pub fn validate_image_attachment(path: &Path, size: u64) -> Result<&'static str, AttachmentError> {
    let mime = image_mime_for_path(path).ok_or(AttachmentError::NotAnImage)?;
    if size > MAX_IMAGE_BYTES {
        return Err(AttachmentError::TooLarge(size));
    }
    Ok(mime)
}

/// Build a persisted-ready image `Attachment` from raw bytes (base64-encoded
/// into `data`, no `data:` prefix — the shape `aiden_core::Attachment` expects).
pub fn attachment_from_image_bytes(
    name: String,
    mime_type: &str,
    size: u64,
    bytes: Vec<u8>,
) -> Attachment {
    Attachment {
        id: new_uuid_like(),
        name,
        mime_type: mime_type.to_string(),
        kind: AttachmentKind::Image,
        size,
        data: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
        text: None,
    }
}

/// Read + validate one picked image file (I/O on the caller's executor).
pub fn read_image_attachment(path: &Path) -> Result<Attachment, AttachmentError> {
    let metadata =
        std::fs::metadata(path).map_err(|error| AttachmentError::Unreadable(error.to_string()))?;
    if !metadata.is_file() {
        return Err(AttachmentError::Unreadable("not a regular file".into()));
    }
    let mime = validate_image_attachment(path, metadata.len())?;
    let bytes =
        std::fs::read(path).map_err(|error| AttachmentError::Unreadable(error.to_string()))?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "attachment".to_string());
    Ok(attachment_from_image_bytes(
        name,
        mime,
        metadata.len(),
        bytes,
    ))
}

/// Human-friendly byte size for attachment chips ("1.2 MB", "340 KB").
pub fn format_bytes(size: u64) -> String {
    if size >= 1024 * 1024 {
        format!("{:.1} MB", size as f64 / (1024.0 * 1024.0))
    } else if size >= 1024 {
        format!("{} KB", size / 1024)
    } else {
        format!("{size} B")
    }
}

// ===========================================================================
// Attachment rendering
// ===========================================================================

/// The mime types GPUI's image pipeline can decode for inline rendering.
pub fn renderable_image_format(mime_type: &str) -> Option<gpui::ImageFormat> {
    match mime_type {
        "image/png" => Some(gpui::ImageFormat::Png),
        "image/jpeg" | "image/jpg" => Some(gpui::ImageFormat::Jpeg),
        "image/gif" => Some(gpui::ImageFormat::Gif),
        "image/webp" => Some(gpui::ImageFormat::Webp),
        _ => None,
    }
}

/// Render a staged/persisted image attachment as an inline `img`, scaled to at
/// most `max_width_px` wide (object-fit contain). `None` when the attachment
/// has no base64 data or its mime type isn't renderable (callers fall back to a
/// file chip).
pub fn attachment_image_element(
    attachment: &Attachment,
    max_width_px: f32,
) -> Option<gpui::AnyElement> {
    let data = attachment.data.as_deref()?;
    let format = renderable_image_format(&attachment.mime_type)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .ok()?;
    let image = Arc::new(gpui::Image::from_bytes(format, bytes));
    Some(
        gpui::img(image)
            .max_w(gpui::px(max_width_px))
            .object_fit(gpui::ObjectFit::Contain)
            .rounded_md()
            .into_any_element(),
    )
}

// ===========================================================================
// Edit rebranch (gap 6)
// ===========================================================================

/// Truncate the transcript for an edit: the prefix *before* `message_id` —
/// the edited message and everything after it are removed so the edited text
/// is re-sent as a fresh turn (a rebranch). Returns `None` when the target
/// isn't in the list (stale edit target) so the caller falls back to a plain
/// send instead of nuking history.
pub fn truncate_history_after(
    messages: &[ChatMessage],
    message_id: &str,
) -> Option<Vec<ChatMessage>> {
    let index = messages
        .iter()
        .position(|message| message.id == message_id)?;
    Some(messages[..index].to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_core::ChatRole;

    #[test]
    fn model_key_roundtrips() {
        let key = model_key("custom:lmstudio", "qwen2.5-coder");
        assert_eq!(
            decode_model_key(&key),
            Some(("custom:lmstudio".to_string(), "qwen2.5-coder".to_string()))
        );
        assert!(decode_model_key("no-separator").is_none());
        assert!(decode_model_key("\u{0}").is_none());
    }

    #[test]
    fn model_items_flatten_providers_and_defaults() {
        let providers = vec![
            ConfiguredProvider {
                id: "anthropic".into(),
                label: "Anthropic".into(),
                kind: aiden_data::portable_config::ProviderKind::Anthropic,
                base_url: String::new(),
                models: vec!["claude-sonnet-5".into(), "claude-sonnet-6".into()],
                default_model: None,
                model_metadata: Default::default(),
                catalog_models: vec!["claude-sonnet-6".into()],
                needs_key: true,
                has_key: true,
            },
            ConfiguredProvider {
                id: "custom:lmstudio".into(),
                label: "LM Studio".into(),
                kind: aiden_data::portable_config::ProviderKind::Openai,
                base_url: String::new(),
                models: vec!["qwen2.5-coder".into()],
                default_model: Some("qwen2.5-coder".into()),
                model_metadata: Default::default(),
                catalog_models: Vec::new(),
                needs_key: false,
                has_key: false,
            },
        ];
        let items = model_items(&providers);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].value(), "anthropic\u{0}claude-sonnet-5");
        assert!(!items[0].discovered, "preset models carry no badge");
        assert_eq!(items[1].value(), "anthropic\u{0}claude-sonnet-6");
        assert!(items[1].discovered, "catalog-sourced models are badged");
        assert_eq!(items[2].value(), "custom:lmstudio\u{0}qwen2.5-coder");
        assert!(!items[2].discovered);
    }

    // -----------------------------------------------------------------------
    // Attachment validation + reading
    // -----------------------------------------------------------------------

    fn image_attachment(name: &str, mime: &str, bytes: &[u8]) -> Attachment {
        attachment_from_image_bytes(name.to_string(), mime, bytes.len() as u64, bytes.to_vec())
    }

    #[test]
    fn image_mime_maps_accepted_extensions() {
        let cases = [
            ("shot.png", Some("image/png")),
            ("photo.JPG", Some("image/jpeg")), // case-insensitive
            ("photo.jpg", Some("image/jpeg")),
            ("anim.gif", Some("image/gif")),
            ("web.webp", Some("image/webp")),
            ("notes.txt", None),
            ("archive.zip", None),
            ("no-extension", None),
        ];
        for (name, expected) in cases {
            assert_eq!(
                image_mime_for_path(Path::new(name)),
                expected,
                "unexpected mapping for {name}"
            );
        }
    }

    #[test]
    fn attachment_validation_rejects_non_images_and_oversized_files() {
        // A huge non-image is NotAnImage, not TooLarge (mirrors attachments.ts
        // which resolves the mime before checking size).
        assert_eq!(
            validate_image_attachment(Path::new("data.bin"), MAX_IMAGE_BYTES + 1),
            Err(AttachmentError::NotAnImage)
        );
        // An image exactly at the cap is accepted.
        assert_eq!(
            validate_image_attachment(Path::new("big.png"), MAX_IMAGE_BYTES),
            Ok("image/png")
        );
        // Over the cap → TooLarge.
        assert_eq!(
            validate_image_attachment(Path::new("big.png"), MAX_IMAGE_BYTES + 1),
            Err(AttachmentError::TooLarge(MAX_IMAGE_BYTES + 1))
        );
        // A small accepted file.
        assert_eq!(
            validate_image_attachment(Path::new("small.webp"), 1_024),
            Ok("image/webp")
        );
    }

    #[test]
    fn attachment_from_bytes_roundtrips_base64() {
        let bytes = b"\x89PNG\r\n\x1a\nhello-world";
        let attachment = image_attachment("pixel.png", "image/png", bytes);
        assert_eq!(attachment.kind, AttachmentKind::Image);
        assert_eq!(attachment.mime_type, "image/png");
        assert_eq!(attachment.size, bytes.len() as u64);
        assert!(attachment.text.is_none());
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(attachment.data.as_deref().unwrap())
            .unwrap();
        assert_eq!(decoded, bytes, "base64 data must round-trip the raw bytes");
        assert!(!attachment.id.is_empty());
        assert_eq!(attachment.name, "pixel.png");
    }

    #[test]
    fn renderable_formats_and_attachment_kind_agree() {
        // A renderable mime maps to a GPUI format...
        assert!(renderable_image_format("image/png").is_some());
        assert!(renderable_image_format("image/gif").is_some());
        assert!(renderable_image_format("image/webp").is_some());
        // ...while unsupported formats (heic, bmp, …) fall back to a file chip.
        assert!(renderable_image_format("image/heic").is_none());
        assert!(renderable_image_format("image/bmp").is_none());
        // The image element builder only returns an element for renderable,
        // data-carrying image attachments.
        assert!(
            attachment_image_element(&image_attachment("a.png", "image/png", b"x"), 400.0)
                .is_some()
        );
        assert!(
            attachment_image_element(&image_attachment("a.heic", "image/heic", b"x"), 400.0)
                .is_none()
        );
        // Text-kind attachments are never renderable images.
        let text = Attachment {
            id: "t1".into(),
            name: "notes.txt".into(),
            mime_type: "text/plain".into(),
            kind: AttachmentKind::Text,
            size: 4,
            data: None,
            text: Some("hi".into()),
        };
        assert!(attachment_image_element(&text, 400.0).is_none());
    }

    #[test]
    fn format_bytes_labels() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(2048), "2 KB");
        assert_eq!(format_bytes(3 * 1024 * 1024), "3.0 MB");
    }

    // -----------------------------------------------------------------------
    // Composer draft state machine
    // -----------------------------------------------------------------------

    #[test]
    fn draft_add_remove_and_dedupe_attachments() {
        let mut draft = ComposerDraft::default();
        let first = image_attachment("a.png", "image/png", b"a");
        let duplicate = first.clone();
        assert!(draft.add_attachment(first.clone()));
        assert!(
            !draft.add_attachment(duplicate),
            "duplicate ids are rejected"
        );
        assert_eq!(draft.attachments.len(), 1);
        assert!(draft.has_attachments());
        assert!(!draft.remove_attachment("missing"));
        assert!(draft.remove_attachment(&first.id));
        assert!(!draft.has_attachments());
    }

    #[test]
    fn draft_edit_state_machine() {
        let mut draft = ComposerDraft::default();
        assert!(!draft.is_editing());
        draft.begin_edit("user-3".to_string());
        assert!(draft.is_editing());
        assert_eq!(draft.editing_message_id.as_deref(), Some("user-3"));
        // begin_edit replaces the previous target.
        draft.begin_edit("user-2".to_string());
        assert_eq!(draft.editing_message_id.as_deref(), Some("user-2"));
        draft.cancel_edit();
        assert!(!draft.is_editing());
        // clear() resets attachments and the edit target together.
        draft.add_attachment(image_attachment("a.png", "image/png", b"a"));
        draft.begin_edit("user-1".to_string());
        draft.clear();
        assert!(draft.attachments.is_empty());
        assert!(!draft.is_editing());
    }

    // -----------------------------------------------------------------------
    // Edit rebranch truncation
    // -----------------------------------------------------------------------

    fn user_message(id: &str) -> ChatMessage {
        ChatMessage {
            id: id.into(),
            role: ChatRole::User,
            content: format!("content-{id}"),
            created_at: 1,
            model: None,
            reasoning: None,
            attachments: None,
            timeline: None,
            subagents: None,
        }
    }

    fn assistant_message(id: &str) -> ChatMessage {
        ChatMessage {
            id: id.into(),
            role: ChatRole::Assistant,
            content: format!("reply-{id}"),
            created_at: 1,
            model: None,
            reasoning: None,
            attachments: None,
            timeline: None,
            subagents: None,
        }
    }

    #[test]
    fn truncate_history_removes_target_and_everything_after() {
        let history = vec![
            user_message("user-1"),
            assistant_message("assistant-1"),
            user_message("user-2"),
            assistant_message("assistant-2"),
        ];
        // Editing user-2 drops it plus the assistant reply after it.
        let truncated = truncate_history_after(&history, "user-2").unwrap();
        assert_eq!(
            truncated
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            vec!["user-1", "assistant-1"]
        );
        // Editing the first message drops everything (the edit becomes turn 1).
        let truncated = truncate_history_after(&history, "user-1").unwrap();
        assert!(truncated.is_empty());
    }

    #[test]
    fn truncate_history_preserves_order_and_payload() {
        let history = vec![user_message("user-1"), assistant_message("assistant-1")];
        let truncated = truncate_history_after(&history, "assistant-1").unwrap();
        assert_eq!(truncated.len(), 1);
        assert_eq!(truncated[0].id, "user-1");
        assert_eq!(truncated[0].content, "content-user-1");
    }

    #[test]
    fn truncate_history_is_none_for_stale_targets() {
        let history = vec![user_message("user-1"), assistant_message("assistant-1")];
        // A stale edit target (message no longer in the transcript) must not
        // nuke history — the caller falls back to a plain send.
        assert!(truncate_history_after(&history, "user-99").is_none());
        assert!(truncate_history_after(&[], "user-1").is_none());
    }
}
