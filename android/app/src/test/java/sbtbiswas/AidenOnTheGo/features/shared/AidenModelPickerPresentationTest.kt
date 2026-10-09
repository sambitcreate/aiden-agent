package sbtbiswas.AidenOnTheGo.features.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenBotModelOption
import sbtbiswas.AidenOnTheGo.models.AidenBotProviderOption
import sbtbiswas.AidenOnTheGo.models.AidenModel
import sbtbiswas.AidenOnTheGo.models.AidenProvider

class AidenModelPickerPresentationTest {
    private val deepseekV3 = AidenModelPickerModel(id = "deepseek-v3", label = "DeepSeek V3")
    private val deepseekR1 = AidenModelPickerModel(
        id = "deepseek-r1",
        label = "DeepSeek R1",
        capabilities = listOf(AidenModelCapability.REASONING)
    )
    private val deepseek = AidenModelPickerProvider(id = "deepseek", label = "DeepSeek", models = listOf(deepseekV3, deepseekR1))
    private val opencodeGo = AidenModelPickerProvider(id = "opencode-go", label = "OpenCode Go", models = listOf(deepseekV3))
    private val anthropic = AidenModelPickerProvider(
        id = "anthropic",
        label = "Anthropic",
        models = listOf(
            AidenModelPickerModel(id = "claude-opus-4-1", label = "Claude Opus 4.1"),
            AidenModelPickerModel(id = "claude-sonnet-4-5", label = "Claude Sonnet 4.5")
        )
    )
    private val inventory = listOf(deepseek, opencodeGo, anthropic)

    private fun AidenModelPickerContent.selectedKeys(): List<String> =
        sections.flatMap { it.rows }.filter { it.isSelected }.map { it.entry.key }

    @Test
    fun theSameModelUnderTwoProvidersIsTwoRoutesAndOnlyThePickedProvidersRowIsChecked() {
        val content = aidenModelPickerContent(inventory, selection = AidenModelRoute("opencode-go", "deepseek-v3"))

        val v3Keys = content.sections.flatMap { it.rows }.filter { it.entry.model.id == "deepseek-v3" }.map { it.entry.key }
        assertEquals(listOf("deepseek/deepseek-v3", "opencode-go/deepseek-v3"), v3Keys)
        assertEquals(listOf("opencode-go/deepseek-v3"), content.selectedKeys())
        assertEquals("OpenCode Go", content.current?.provider?.label)
        assertFalse(content.showsDefault)
    }

    @Test
    fun everyLazyItemKeyIsUniqueEvenWhenTheHostRepeatsAProviderOrModel() {
        val repeated = listOf(
            deepseek.copy(models = listOf(deepseekV3, deepseekV3.copy(label = "Duplicate"), deepseekR1)),
            deepseek,
            opencodeGo,
            AidenModelPickerProvider(id = "empty", label = "Empty", models = emptyList())
        )
        val content = aidenModelPickerContent(
            repeated,
            selection = AidenModelRoute("deepseek", "deepseek-r1"),
            recentRoutes = listOf(AidenModelRoute("opencode-go", "deepseek-v3"))
        )
        val keys = aidenModelPickerItems(content).map { it.key }

        assertEquals(keys.size, keys.toSet().size)
        assertEquals(listOf("deepseek", "opencode-go"), content.sections.map { it.provider.id })
        assertEquals(listOf("DeepSeek V3", "DeepSeek R1"), content.sections.first().rows.map { it.entry.model.label })
    }

    @Test
    fun searchMatchesEveryWordAgainstLabelIdAndProviderIgnoringCase() {
        fun matches(query: String) = aidenModelPickerContent(inventory, selection = null, query = query)
            .sections.flatMap { it.rows }.map { it.entry.key }

        assertEquals(listOf("anthropic/claude-opus-4-1"), matches("OPUS claude"))
        // A provider name finds all of that provider's models.
        assertEquals(listOf("opencode-go/deepseek-v3"), matches("opencode"))
        // Ids match even when the label reads differently.
        assertEquals(listOf("anthropic/claude-sonnet-4-5"), matches("sonnet-4-5"))
        assertEquals(listOf("deepseek/deepseek-v3", "opencode-go/deepseek-v3"), matches("  v3 "))
    }

    @Test
    fun aSearchWithNoMatchesEndsInTheEmptyStateOnly() {
        val content = aidenModelPickerContent(
            inventory,
            selection = null,
            recentRoutes = listOf(AidenModelRoute("deepseek", "deepseek-r1")),
            query = "gemini",
            allowsDefault = true
        )

        assertTrue(content.hasNoResults)
        assertEquals(listOf(AidenModelPickerItem.NoResults), aidenModelPickerItems(content))
    }

    @Test
    fun collapsingAGroupKeepsItsHeaderAndSearchingOpensIt() {
        val collapsed = setOf("deepseek")
        val browsing = aidenModelPickerItems(aidenModelPickerContent(inventory, null, collapsedProviderIds = collapsed))
        assertTrue(browsing.any { it.key == "provider:deepseek" })
        assertFalse(browsing.any { it.key == "deepseek/deepseek-r1" })
        assertTrue(browsing.any { it.key == "anthropic/claude-opus-4-1" })

        val searching = aidenModelPickerItems(
            aidenModelPickerContent(inventory, null, query = "r1", collapsedProviderIds = collapsed)
        )
        assertEquals(listOf("provider:deepseek", "deepseek/deepseek-r1"), searching.map { it.key })
    }

    @Test
    fun withoutAListedSelectionTheDefaultRowIsCheckedAndNamesWhatTheMacWouldUse() {
        val defaultRoute = AidenModelRoute("anthropic", "claude-sonnet-4-5")
        for (selection in listOf(null, AidenModelRoute("removed", "gone"))) {
            val content = aidenModelPickerContent(inventory, selection, defaultRoute = defaultRoute, allowsDefault = true)
            assertTrue(content.showsDefault)
            assertNull(content.current)
            assertEquals("Claude Sonnet 4.5", content.defaultEntry?.model?.label)
            assertEquals(emptyList<String>(), content.selectedKeys())
            assertEquals(AidenModelPickerItem.Default, aidenModelPickerItems(content).first())
        }

        // A default the inventory does not list is unknown, not invented.
        val unknown = aidenModelPickerContent(inventory, null, defaultRoute = AidenModelRoute("x", "y"), allowsDefault = true)
        assertTrue(unknown.showsDefault)
        assertNull(unknown.defaultEntry)

        // Screens that always carry an explicit pair never show a Default row.
        assertFalse(aidenModelPickerContent(inventory, null, defaultRoute = defaultRoute).showsDefault)
    }

    @Test
    fun aListedPickThatMatchesTheMacDefaultIsFlaggedAsSuch() {
        val defaultRoute = AidenModelRoute("anthropic", "claude-sonnet-4-5")
        assertTrue(aidenModelPickerContent(inventory, defaultRoute, defaultRoute = defaultRoute, allowsDefault = true).currentIsMacDefault)
        assertFalse(
            aidenModelPickerContent(
                inventory,
                AidenModelRoute("deepseek", "deepseek-r1"),
                defaultRoute = defaultRoute,
                allowsDefault = true
            ).currentIsMacDefault
        )
    }

    @Test
    fun recentListsOtherStillOfferedPicksNewestFirstUpToThree() {
        val unavailable = AidenModelPickerProvider(
            id = "offline",
            label = "Offline",
            models = listOf(AidenModelPickerModel(id = "m", label = "M", available = false))
        )
        val content = aidenModelPickerContent(
            inventory + unavailable,
            selection = AidenModelRoute("deepseek", "deepseek-v3"),
            recentRoutes = listOf(
                AidenModelRoute("deepseek", "deepseek-v3"),
                AidenModelRoute("retired", "model"),
                AidenModelRoute("offline", "m"),
                AidenModelRoute("opencode-go", "deepseek-v3"),
                AidenModelRoute("opencode-go", "deepseek-v3"),
                AidenModelRoute("anthropic", "claude-opus-4-1"),
                AidenModelRoute("deepseek", "deepseek-r1"),
                AidenModelRoute("anthropic", "claude-sonnet-4-5")
            )
        )

        assertEquals(
            listOf("opencode-go/deepseek-v3", "anthropic/claude-opus-4-1", "deepseek/deepseek-r1"),
            content.recent.map { it.entry.key }
        )
        assertEquals(listOf("recent", "recent:opencode-go/deepseek-v3"), aidenModelPickerItems(content).take(2).map { it.key })
    }

    @Test
    fun theListOpensWithTheCheckedRowJustBelowItsStickyHeader() {
        val items = aidenModelPickerItems(aidenModelPickerContent(inventory, AidenModelRoute("anthropic", "claude-sonnet-4-5")))
        val index = aidenModelPickerInitialIndex(items)
        assertEquals("anthropic/claude-opus-4-1", items[index].key)
        assertEquals("anthropic/claude-sonnet-4-5", items[index + 1].key)

        val defaultItems = aidenModelPickerItems(aidenModelPickerContent(inventory, null, allowsDefault = true))
        assertEquals(0, aidenModelPickerInitialIndex(defaultItems))
    }

    @Test
    fun capabilitiesComeFromImageSupportAndThinkingBeyondOff() {
        assertEquals(
            listOf(AidenModelCapability.VISION, AidenModelCapability.REASONING),
            aidenModelCapabilities(AidenModel(id = "a", label = "A", supportsImages = true, thinkingLevels = listOf("off", "high")))
        )
        assertEquals(emptyList<AidenModelCapability>(), aidenModelCapabilities(AidenModel(id = "b", label = "B", thinkingLevels = listOf("off"))))
        // Unknown image support is not advertised as Vision.
        assertEquals(emptyList<AidenModelCapability>(), aidenModelCapabilities(AidenModel(id = "c", label = "C", supportsImages = null)))

        val provider = AidenProvider(
            id = "p",
            label = "P",
            models = listOf(AidenModel(id = "v", label = "V", supportsImages = true))
        ).toModelPickerProvider()
        assertEquals(listOf(AidenModelCapability.VISION), provider.models.single().capabilities)
    }

    @Test
    fun botProvidersThatAreUnavailableListTheirModelsAsUnavailable() {
        val offline = AidenBotProviderOption(
            id = "offline",
            label = "Offline",
            available = false,
            models = listOf(AidenBotModelOption(id = "m", label = "M", available = true))
        ).toModelPickerProvider()
        val mixed = AidenBotProviderOption(
            id = "mixed",
            label = "Mixed",
            available = true,
            models = listOf(
                AidenBotModelOption(id = "up", label = "Up", available = true),
                AidenBotModelOption(id = "down", label = "Down", available = false)
            )
        ).toModelPickerProvider()

        assertEquals(listOf(false), offline.models.map { it.available })
        assertEquals(listOf(true, false), mixed.models.map { it.available })
    }

    @Test
    fun unlistedModelIdsReadAsHumanNames() {
        assertEquals("Claude Opus 4.1", aidenHumanizedModelId("claude-opus-4-1"))
        assertEquals("GPT 4o Mini", aidenHumanizedModelId("openai/gpt-4o-mini"))
        assertEquals("Qwen3 Coder", aidenHumanizedModelId("custom:qwen3_coder"))

        val providers = listOf(AidenProvider(id = "openai", label = "OpenAI", models = listOf(AidenModel(id = "gpt-5", label = "GPT-5"))))
        assertEquals("GPT-5", aidenModelDisplayLabel(providers, "openai", "gpt-5"))
        // A provider that no longer lists the model still borrows another route's label.
        assertEquals("GPT-5", aidenModelDisplayLabel(providers, "router", "gpt-5"))
        assertEquals("Gemini 2.5 Pro", aidenModelDisplayLabel(providers, "google", "gemini-2-5-pro"))
    }
}
