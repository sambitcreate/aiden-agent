package sbtbiswas.AidenOnTheGo.features.shared

import androidx.compose.runtime.Immutable
import sbtbiswas.AidenOnTheGo.models.AidenBotProviderOption
import sbtbiswas.AidenOnTheGo.models.AidenModel
import sbtbiswas.AidenOnTheGo.models.AidenProvider
import sbtbiswas.AidenOnTheGo.models.AidenProviderArtwork

/** What a model offers beyond text, as the picker announces it. */
enum class AidenModelCapability { VISION, REASONING }

/**
 * One model as the shared picker shows it. Workspace catalogs and Bot capability
 * catalogs both map into this, so every screen lists models the same way.
 */
@Immutable
data class AidenModelPickerModel(
    val id: String,
    val label: String,
    val capabilities: List<AidenModelCapability> = emptyList(),
    val available: Boolean = true
)

@Immutable
data class AidenModelPickerProvider(
    val id: String,
    val label: String,
    val artwork: AidenProviderArtwork? = null,
    val models: List<AidenModelPickerModel>
)

/** A provider/model pair. The same model id under two providers is two distinct routes. */
data class AidenModelRoute(val providerId: String, val modelId: String)

@Immutable
data class AidenModelPickerEntry(val provider: AidenModelPickerProvider, val model: AidenModelPickerModel) {
    val route: AidenModelRoute get() = AidenModelRoute(provider.id, model.id)

    /** Stable LazyColumn key, unique per route. */
    val key: String get() = "${provider.id}/${model.id}"
}

@Immutable
data class AidenModelPickerRow(val entry: AidenModelPickerEntry, val isSelected: Boolean)

@Immutable
data class AidenModelPickerSection(
    val provider: AidenModelPickerProvider,
    val rows: List<AidenModelPickerRow>,
    val isCollapsed: Boolean
) {
    val containsSelection: Boolean get() = rows.any { it.isSelected }
}

/**
 * Everything the picker renders for one state of its inputs.
 *
 * [current] is the row the selection points at. When nothing in the inventory matches
 * and the caller allows it, [showsDefault] is true: the chat runs on the Mac's default
 * model, which [defaultEntry] names when the catalog says what it is.
 */
@Immutable
data class AidenModelPickerContent(
    val current: AidenModelPickerEntry?,
    val showsDefault: Boolean,
    val defaultEntry: AidenModelPickerEntry?,
    val recent: List<AidenModelPickerRow>,
    val sections: List<AidenModelPickerSection>,
    val query: String
) {
    val isSearching: Boolean get() = query.isNotBlank()
    val hasNoResults: Boolean get() = isSearching && sections.isEmpty()

    /** True when the current route is also what the Mac would pick by default. */
    val currentIsMacDefault: Boolean
        get() = current != null && defaultEntry != null && current.route == defaultEntry.route
}

/** Flat item list for the LazyColumn, in display order, each with a unique key. */
sealed interface AidenModelPickerItem {
    val key: String

    data object Default : AidenModelPickerItem { override val key = "default" }
    data object RecentHeader : AidenModelPickerItem { override val key = "recent" }
    data class Recent(val row: AidenModelPickerRow) : AidenModelPickerItem {
        override val key = "recent:${row.entry.key}"
    }
    data class Header(val section: AidenModelPickerSection) : AidenModelPickerItem {
        override val key = "provider:${section.provider.id}"
    }
    data class Model(val row: AidenModelPickerRow) : AidenModelPickerItem {
        override val key = row.entry.key
    }
    data object NoResults : AidenModelPickerItem { override val key = "no-results" }
}

const val AidenModelPickerRecentLimit = 3

/**
 * Builds the picker for [providers]. A row is selected only when both its provider and
 * model match [selection]; a provider listed twice keeps its first copy, and a model id
 * repeated inside one provider keeps its first row, so every key stays unique. Searching
 * matches every word of [query] against the model label, model id and provider label,
 * ignoring case, opens collapsed groups and hides the Default and Recent shortcuts.
 */
fun aidenModelPickerContent(
    providers: List<AidenModelPickerProvider>,
    selection: AidenModelRoute?,
    defaultRoute: AidenModelRoute? = null,
    recentRoutes: List<AidenModelRoute> = emptyList(),
    query: String = "",
    collapsedProviderIds: Set<String> = emptySet(),
    allowsDefault: Boolean = false
): AidenModelPickerContent {
    val inventory = providers
        .distinctBy { it.id }
        .map { provider -> provider.copy(models = provider.models.distinctBy { it.id }) }
        .filter { it.models.isNotEmpty() }

    fun find(route: AidenModelRoute?): AidenModelPickerEntry? {
        route ?: return null
        val provider = inventory.firstOrNull { it.id == route.providerId } ?: return null
        val model = provider.models.firstOrNull { it.id == route.modelId } ?: return null
        return AidenModelPickerEntry(provider, model)
    }

    val current = find(selection)
    val defaultEntry = find(defaultRoute)?.takeIf { it.model.available }
    val showsDefault = allowsDefault && current == null
    val tokens = aidenModelPickerQueryTokens(query)
    val searching = tokens.isNotEmpty()

    val recent = if (searching) emptyList() else recentRoutes
        .distinct()
        .mapNotNull { find(it) }
        .filter { it.model.available && it.route != current?.route }
        .take(AidenModelPickerRecentLimit)
        .map { AidenModelPickerRow(it, isSelected = false) }

    val sections = inventory.mapNotNull { provider ->
        val rows = provider.models
            .filter { model -> !searching || aidenModelPickerMatches(provider, model, tokens) }
            .map { model ->
                AidenModelPickerRow(
                    entry = AidenModelPickerEntry(provider, model),
                    isSelected = current?.route == AidenModelRoute(provider.id, model.id)
                )
            }
        if (rows.isEmpty()) return@mapNotNull null
        AidenModelPickerSection(
            provider = provider,
            rows = rows,
            isCollapsed = !searching && provider.id in collapsedProviderIds
        )
    }

    return AidenModelPickerContent(
        current = current,
        showsDefault = showsDefault && !searching,
        defaultEntry = defaultEntry,
        recent = recent,
        sections = sections,
        query = query
    )
}

/** LazyColumn items for [content]: Default, Recent, then each provider and its open rows. */
fun aidenModelPickerItems(content: AidenModelPickerContent): List<AidenModelPickerItem> = buildList {
    if (content.showsDefault) add(AidenModelPickerItem.Default)
    if (content.recent.isNotEmpty()) {
        add(AidenModelPickerItem.RecentHeader)
        content.recent.forEach { add(AidenModelPickerItem.Recent(it)) }
    }
    content.sections.forEach { section ->
        add(AidenModelPickerItem.Header(section))
        if (!section.isCollapsed) section.rows.forEach { add(AidenModelPickerItem.Model(it)) }
    }
    if (content.hasNoResults) add(AidenModelPickerItem.NoResults)
}

/**
 * Index the list should open at so the checked row sits just under its sticky provider
 * header, or 0 when the selection is the Default row, a collapsed group, or absent.
 */
fun aidenModelPickerInitialIndex(items: List<AidenModelPickerItem>): Int {
    val index = items.indexOfFirst { it is AidenModelPickerItem.Model && it.row.isSelected }
    return if (index <= 0) 0 else index - 1
}

private fun aidenModelPickerQueryTokens(query: String): List<String> =
    query.trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }

private fun aidenModelPickerMatches(
    provider: AidenModelPickerProvider,
    model: AidenModelPickerModel,
    tokens: List<String>
): Boolean {
    val haystack = listOf(model.label, model.id, provider.label).joinToString(" ").lowercase()
    return tokens.all { haystack.contains(it) }
}

/** Vision when the host says the model reads images; Reasoning when it has a thinking effort beyond off. */
fun aidenModelCapabilities(model: AidenModel): List<AidenModelCapability> = buildList {
    if (model.supportsImages == true) add(AidenModelCapability.VISION)
    if (model.thinkingLevels.orEmpty().any { it != "off" }) add(AidenModelCapability.REASONING)
}

fun AidenProvider.toModelPickerProvider(): AidenModelPickerProvider = AidenModelPickerProvider(
    id = id,
    label = label,
    artwork = artwork,
    models = models.map { model ->
        AidenModelPickerModel(id = model.id, label = model.label, capabilities = aidenModelCapabilities(model))
    }
)

/** Bot capability catalogs carry no artwork or capability detail; unavailable models stay listed but disabled. */
fun AidenBotProviderOption.toModelPickerProvider(): AidenModelPickerProvider = AidenModelPickerProvider(
    id = id,
    label = label,
    models = models.map { model ->
        AidenModelPickerModel(id = model.id, label = model.label, available = available && model.available)
    }
)

/**
 * A readable name for a model the inventory does not list: the last path segment with
 * separators turned into spaces, version pairs such as `4-1` joined as `4.1`, and each
 * word capitalised (`claude-opus-4-1` reads "Claude Opus 4.1").
 */
fun aidenHumanizedModelId(modelId: String): String {
    val tail = modelId.trim().substringAfterLast('/').substringAfterLast(':').ifEmpty { modelId.trim() }
    val versioned = tail.replace(Regex("(?<=\\d)[-_](?=\\d)"), ".")
    return versioned.split('-', '_', ' ')
        .filter { it.isNotEmpty() }
        .joinToString(" ") { word ->
            when {
                word.lowercase() in AidenModelIdAcronyms -> word.uppercase()
                else -> word.replaceFirstChar { it.uppercase() }
            }
        }
        .ifEmpty { modelId }
}

private val AidenModelIdAcronyms = setOf("gpt", "glm", "oss", "ai", "llm")

/** Label for [modelId] under [providerId]: the catalog label when listed, else a humanized id. */
fun aidenModelDisplayLabel(providers: List<AidenProvider>, providerId: String?, modelId: String): String {
    val listed = providers.firstOrNull { it.id == providerId }?.models?.firstOrNull { it.id == modelId }
        ?: providers.asSequence().flatMap { it.models.asSequence() }.firstOrNull { it.id == modelId }
    return listed?.label ?: aidenHumanizedModelId(modelId)
}
