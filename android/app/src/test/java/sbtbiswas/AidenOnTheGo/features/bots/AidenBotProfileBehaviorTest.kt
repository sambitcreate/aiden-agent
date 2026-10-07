package sbtbiswas.AidenOnTheGo.features.bots

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.AidenRemoteContractFixture
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability

class AidenBotProfileBehaviorTest {
    private val json = Json { ignoreUnknownKeys = true }

    private val fixture: AidenRemoteContractFixture by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json")) { "contract.json missing" }
            .bufferedReader().use { it.readText() }
        json.decodeFromString(text)
    }

    private fun server(features: List<String>, capabilities: List<AidenRemoteCapability>) = AidenServer(
        instanceId = "mac-1",
        name = "Mac",
        capabilities = capabilities,
        features = features
    )

    // Delete confirmation

    @Test
    fun deleteConfirmationUsesTheExactPermanentEraseCopy() {
        val copy = aidenBotDeleteCopy("Meal Planner")
        assertEquals("Delete Meal Planner?", copy.title)
        assertEquals(
            "This permanently erases Meal Planner's chat, memory, instructions, routines, files, and photo. This can't be undone.",
            copy.message
        )
        assertEquals("Delete Bot", copy.confirm)
        assertEquals("Cancel", copy.cancel)
    }

    @Test
    fun deleteConfirmationTrimsTheNameItQuotes() {
        val copy = aidenBotDeleteCopy("  Scout ")
        assertEquals("Delete Scout?", copy.title)
        assertTrue(copy.message.startsWith("This permanently erases Scout's chat"))
    }

    @Test
    fun deleteIsHiddenUntilTheMacAdvertisesItAndThePhoneMayChangeBots() {
        val deleter = AidenBotDeleter { _, _ -> }
        val writable = listOf(AidenRemoteCapability.BOT_READ, AidenRemoteCapability.BOT_WRITE)

        // Today's Macs: no feature token, so Delete stays hidden even with write access.
        assertFalse(aidenBotDeleteAvailable(server(emptyList(), writable), deleter))
        // Advertised, but this phone was only granted read access.
        assertFalse(aidenBotDeleteAvailable(server(listOf(AIDEN_BOT_DELETE_FEATURE), listOf(AidenRemoteCapability.BOT_READ)), deleter))
        // Advertised and writable, but no client route to call yet.
        assertFalse(aidenBotDeleteAvailable(server(listOf(AIDEN_BOT_DELETE_FEATURE), writable), null))
        assertFalse(aidenBotDeleteAvailable(null, deleter))

        assertTrue(aidenBotDeleteAvailable(server(listOf(AIDEN_BOT_DELETE_FEATURE), writable), deleter))
    }

    // Character

    @Test
    fun characterResetRestoresTheDesktopDefaultLook() {
        val reset = AidenBotCharacter.reset()
        // The desktop's DEFAULT_BOT_AVATAR is a lilac wisp.
        assertEquals(AidenBotAvatarShape.WISP, reset.shape)
        assertEquals(AidenBotAvatarColor.LILAC, reset.color)
        assertTrue(AidenBotCharacter.isDefault(reset))
    }

    @Test
    fun characterResetOnACustomizedBotSavesOnlyTheAvatar() {
        val bot = fixture.botDetail
        // The fixture Bot is a sky orb, not the default.
        assertFalse(AidenBotCharacter.isDefault(AidenBotCharacter.recipe(bot.avatar.semantic)))

        val patch = requireNotNull(aidenBotCharacterPatch(bot, AidenBotCharacter.reset()))
        val avatar = patch.avatar as AidenBotSemanticAvatar.Recipe
        assertEquals(AidenBotAvatarShape.WISP, avatar.recipe.shape)
        assertEquals(AidenBotAvatarColor.LILAC, avatar.recipe.color)
        assertNull(patch.name)
        assertNull(patch.purpose)
        assertNull(patch.instructions)
        assertNull(patch.openingGreeting)
    }

    @Test
    fun characterResetOnADefaultBotChangesNothing() {
        val bot = fixture.botDetail.copy(
            avatar = fixture.botDetail.avatar.copy(semantic = AidenBotSemanticAvatar.Recipe(AidenBotCharacter.reset()))
        )
        assertNull(aidenBotCharacterPatch(bot, AidenBotCharacter.reset()))
    }

    @Test
    fun characterChoicesChangeOneAxisAndKeepTheOther() {
        val start = AidenBotCharacter.recipe(fixture.botDetail.avatar.semantic)
        val recoloured = AidenBotCharacter.withColor(start, AidenBotAvatarColor.CORAL)
        assertEquals(start.shape, recoloured.shape)
        assertEquals(AidenBotAvatarColor.CORAL, recoloured.color)

        val reshaped = AidenBotCharacter.withShape(recoloured, AidenBotAvatarShape.HEX)
        assertEquals(AidenBotAvatarColor.CORAL, reshaped.color)
        assertEquals(AidenBotAvatarShape.HEX, reshaped.shape)
    }

    @Test
    fun characterOffersEightShapesAndEveryWireColour() {
        assertEquals(8, AidenBotCharacter.SHAPES.toSet().size)
        assertEquals(AidenBotAvatarShape.entries.toSet(), AidenBotCharacter.SHAPES.toSet())
        assertEquals(AidenBotAvatarColor.entries.toSet(), AidenBotCharacter.COLORS.toSet())
    }

    @Test
    fun autoAssignedCharacterIsStablePerNameAndVariesAcrossNames() {
        assertEquals(AidenBotCharacter.autoAssigned("Meal Planner"), AidenBotCharacter.autoAssigned("  meal planner "))
        val looks = listOf("Meal Planner", "Chief of Staff", "Inbox Helper", "Researcher", "Scout", "Coach")
            .map { AidenBotCharacter.autoAssigned(it) }
            .map { it.shape to it.color }
            .toSet()
        assertTrue("expected different looks, got $looks", looks.size > 1)
    }

    // Inline name and subtitle

    @Test
    fun inlineEditsSaveOnlyWhatChanged() {
        val bot = fixture.botDetail
        assertNull(aidenBotIdentityTextPatch(bot, bot.name, bot.purpose))
        assertNull(aidenBotIdentityTextPatch(bot, "  ${bot.name}  ", bot.purpose))

        val renamed = requireNotNull(aidenBotIdentityTextPatch(bot, "Ranger", bot.purpose))
        assertEquals("Ranger", renamed.name)
        assertNull(renamed.purpose)

        val resubtitled = requireNotNull(aidenBotIdentityTextPatch(bot, bot.name, "Plans meals"))
        assertNull(resubtitled.name)
        assertEquals("Plans meals", resubtitled.purpose)
    }

    @Test
    fun clearingTheNameNeverSavesAnEmptyName() {
        val bot = fixture.botDetail
        assertNull(aidenBotIdentityTextPatch(bot, "   ", bot.purpose))
        val onlySubtitle = requireNotNull(aidenBotIdentityTextPatch(bot, "", "New subtitle"))
        assertNull(onlySubtitle.name)
        assertEquals("New subtitle", onlySubtitle.purpose)
    }

    // Create flow

    @Test
    fun subtitleIsTheFirstLineOfTheAnswerWithinTheWireLimit() {
        assertEquals("Plan my meals", aidenBotSubtitle("  Plan my meals \nand buy groceries"))
        val long = "a".repeat(AidenBotWire.MAX_PURPOSE_LENGTH + 40)
        assertEquals(AidenBotWire.MAX_PURPOSE_LENGTH, aidenBotSubtitle(long).length)
        assertEquals("", aidenBotSubtitle("   "))
    }

    @Test
    fun createUsesTheAnswerAsSubtitleAndInstructionsAndOmitsAccess() {
        val request = requireNotNull(
            AidenBotCreateDraft(name = " Meal Planner ", help = "Plan my meals\nKeep it cheap").request()
        )
        assertEquals("Meal Planner", request.name)
        assertEquals("Plan my meals", request.purpose)
        assertEquals("Plan my meals\nKeep it cheap", request.instructions)
        assertEquals(AidenBotSemanticAvatar.Recipe(AidenBotCharacter.autoAssigned("Meal Planner")), request.avatar)
        // Revision 25: no access on the wire means Full; no model is required to create.
        val wire = AidenBotWireJson.json.parseToJsonElement(
            AidenBotWireJson.json.encodeToString(AidenBotCreateRequest.serializer(), request)
        ) as kotlinx.serialization.json.JsonObject
        assertFalse(wire.containsKey("access"))
    }

    @Test
    fun createWithoutAnAnswerFallsBackToDefaultInstructions() {
        val request = requireNotNull(AidenBotCreateDraft(name = "Scout").request())
        assertEquals("", request.purpose)
        assertEquals(AIDEN_BOT_DEFAULT_INSTRUCTIONS, request.instructions)
    }

    @Test
    fun createNeedsAName() {
        assertNull(AidenBotCreateDraft(name = "  ", help = "Anything").request())
    }

    // Advanced

    @Test
    fun advancedGreetingClearsWithAnEmptyStringAndSkipsUnchangedText() {
        val bot = fixture.botDetail
        val draft = requireNotNull(AidenBotAdvancedDraft.fromDetail(bot, fixture.botCapabilityCatalog))
        assertNull(draft.greetingPatch(bot))
        assertEquals("", draft.copy(openingGreeting = "  ").greetingPatch(bot)?.openingGreeting)
        assertEquals("Hi!", draft.copy(openingGreeting = " Hi! ").greetingPatch(bot)?.openingGreeting)
    }

    @Test
    fun useRecommendedPicksTheFirstAvailableModel() {
        val catalog = fixture.botCapabilityCatalog
        val draft = requireNotNull(AidenBotAdvancedDraft.fromDetail(fixture.botDetail, catalog))
        val other = catalog.providers.flatMap { p -> p.models.filter { it.available }.map { p.id to it.id } }.last()
        val moved = draft.copy(customAccess = draft.customAccess.copy(providerID = other.first, modelID = other.second))
        val recommended = moved.withRecommendedModel(catalog)
        val first = requireNotNull(AidenBotCustomAccessDraft.fromCatalog(catalog))
        assertEquals(first.modelID, recommended.customAccess.modelID)
        assertNotEquals(other.second, recommended.customAccess.modelID)
    }
}
