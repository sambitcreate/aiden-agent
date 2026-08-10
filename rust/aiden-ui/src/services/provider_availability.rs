//! Request-time provider/model availability validation.

use crate::services::provider_kit::{ConfiguredProvider, ModelSelection};

/// A selection that cannot safely be dispatched to a provider.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProviderAvailabilityError {
    /// The selected provider is no longer present in the current snapshot.
    #[error("The selected provider is no longer configured. Choose another provider.")]
    ProviderUnavailable,
    /// The provider exists, but no longer offers the selected model.
    #[error(
        "Model \"{model}\" is no longer available through {provider}. Refresh providers or choose another model."
    )]
    ModelUnavailable { provider: String, model: String },
}

/// Validate the exact provider/model pair immediately before a request starts.
pub fn require_available_selection(
    providers: &[ConfiguredProvider],
    selection: &ModelSelection,
) -> Result<ConfiguredProvider, ProviderAvailabilityError> {
    let provider = providers
        .iter()
        .find(|provider| provider.id == selection.provider_id)
        .ok_or(ProviderAvailabilityError::ProviderUnavailable)?;
    let offered = provider.default_model.as_deref() == Some(selection.model.as_str())
        || provider
            .models
            .iter()
            .any(|model| model == &selection.model)
        || provider
            .catalog_models
            .iter()
            .any(|model| model == &selection.model);
    if !offered {
        return Err(ProviderAvailabilityError::ModelUnavailable {
            provider: provider.label.clone(),
            model: selection.model.clone(),
        });
    }
    Ok(provider.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiden_data::portable_config::ProviderKind;
    use std::collections::HashMap;

    fn provider(models: &[&str], catalog_models: &[&str]) -> ConfiguredProvider {
        ConfiguredProvider {
            id: "custom:test".into(),
            label: "Test".into(),
            kind: ProviderKind::Openai,
            base_url: "https://example.test/v1".into(),
            deployment: None,
            models: models.iter().map(ToString::to_string).collect(),
            default_model: None,
            model_metadata: HashMap::new(),
            catalog_models: catalog_models.iter().map(ToString::to_string).collect(),
            needs_key: false,
            has_key: false,
        }
    }

    #[test]
    fn stale_model_is_rejected_before_dispatch() {
        let selection = ModelSelection {
            provider_id: "custom:test".into(),
            model: "removed-model".into(),
        };
        let error = require_available_selection(&[provider(&["current-model"], &[])], &selection)
            .unwrap_err();
        assert!(matches!(
            error,
            ProviderAvailabilityError::ModelUnavailable { .. }
        ));
    }

    #[test]
    fn catalog_model_is_an_available_selection() {
        let selection = ModelSelection {
            provider_id: "custom:test".into(),
            model: "catalog-model".into(),
        };
        assert!(
            require_available_selection(&[provider(&[], &["catalog-model"])], &selection).is_ok()
        );
    }
}
