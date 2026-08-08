//! Composer support: the model-picker items (shared by the sidebar footer and
//! the composer) and the pure key encode/decode helpers. The interactive
//! composer itself is rendered from `AppState` (see `app.rs`).

use gpui::{
    div, prelude::FluentBuilder as _, App, Entity, IntoElement, ParentElement as _, SharedString,
    Styled as _, Window,
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
