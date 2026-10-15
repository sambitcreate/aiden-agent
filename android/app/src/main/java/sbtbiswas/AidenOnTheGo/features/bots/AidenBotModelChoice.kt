package sbtbiswas.AidenOnTheGo.features.bots

import sbtbiswas.AidenOnTheGo.features.shared.AidenModelCapability
import sbtbiswas.AidenOnTheGo.features.shared.AidenModelPickerModel
import sbtbiswas.AidenOnTheGo.features.shared.AidenModelPickerProvider
import sbtbiswas.AidenOnTheGo.features.shared.AidenModelRoute
import sbtbiswas.AidenOnTheGo.models.AidenBotCapabilityCatalog

/**
 * The Mac's Bot models as the shared picker lists them. Models the Mac can't
 * run right now stay listed but disabled, so the list matches the desktop.
 */
fun aidenBotModelPickerProviders(catalog: AidenBotCapabilityCatalog): List<AidenModelPickerProvider> =
    catalog.providers.map { provider ->
        AidenModelPickerProvider(
            id = provider.id,
            label = provider.label,
            models = provider.models.map { model ->
                AidenModelPickerModel(
                    id = model.id,
                    label = model.label,
                    capabilities = if (model.supportsImages == true) listOf(AidenModelCapability.VISION) else emptyList(),
                    available = provider.available && model.available
                )
            }
        )
    }.filter { it.models.isNotEmpty() }

/** The model a new Bot starts with: the first one the Mac can run. */
fun aidenBotRecommendedModel(catalog: AidenBotCapabilityCatalog): AidenModelRoute? =
    AidenBotCustomAccessDraft.fromCatalog(catalog)?.let { AidenModelRoute(it.providerID, it.modelID) }
