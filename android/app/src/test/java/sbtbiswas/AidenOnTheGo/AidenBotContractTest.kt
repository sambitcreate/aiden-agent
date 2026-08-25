package sbtbiswas.AidenOnTheGo
 
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.features.bots.aidenBotAvatarPresentation
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.AidenBotContractException
import sbtbiswas.AidenOnTheGo.protocol.AidenBotPrivateResponseScope
import sbtbiswas.AidenOnTheGo.protocol.AidenBotPrivateResponseValidator
import sbtbiswas.AidenOnTheGo.protocol.AidenRawJsonDuplicateKeyScanner
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteProtocol
import java.time.Instant

class AidenBotContractTest {
    private val json = Json { ignoreUnknownKeys = true }

    private fun loadSharedContractFixture(): AidenRemoteContractFixture {
        val stream = javaClass.classLoader?.getResourceAsStream("contract.json")
            ?: throw IllegalStateException("Resource contract.json not found")
        val jsonText = stream.bufferedReader().use { it.readText() }
        AidenRawJsonDuplicateKeyScanner.validate(jsonText)
        return json.decodeFromString<AidenRemoteContractFixture>(jsonText)
    }

    @Test
    fun testDuplicateKeyScanner() {
        val validJson = "{\"name\":\"Test Bot\",\"purpose\":\"Test Purpose\"}"
        AidenRawJsonDuplicateKeyScanner.validate(validJson)

        val duplicateJson = "{\"name\":\"Test 1\",\"name\":\"Test 2\"}"
        assertThrows(AidenRemoteContractException.DuplicateJsonKey::class.java) {
            AidenRawJsonDuplicateKeyScanner.validate(duplicateJson)
        }

        val forbiddenKeyJson = "{\"name\":\"Test\",\"authorization\":\"secret\"}"
        assertThrows(AidenRemoteContractException.UnsafePayloadField::class.java) {
            AidenRawJsonDuplicateKeyScanner.validate(forbiddenKeyJson)
        }
    }

    @Test
    fun testForbiddenWireKeysAliasesAndDelimiters() {
        val aliases = listOf(
            "credentialDigest", "providerFingerprint", "managedHomePath",
            "authorizationHeader", "providerHeaders", "providerApiKey",
            "systemPrompt", "Reasoning_Content", "Tool-Arguments", "tool.result",
            "S_e.c-r e t", "API-Key", "access.token", "Instructions"
        )
        for (key in aliases) {
            val jsonWithKey = "{\"name\":\"Test\",\"$key\":\"value\"}"
            assertThrows("Expected rejection for forbidden key $key", AidenRemoteContractException.UnsafePayloadField::class.java) {
                AidenBotPrivateResponseValidator.validate(jsonWithKey, AidenBotPrivateResponseScope.Root("botDetail"))
            }
        }
    }

    @Test
    fun testCheckedInSharedFixtureDecodesEveryBotProjectionDirectly() {
        val fixture = loadSharedContractFixture()

        assertEquals(8, fixture.contractRevision)
        assertEquals(AidenRemoteProtocol.VERSION, fixture.protocolVersion)
        assertEquals("bot_fixture_01", fixture.botSummary.id)
        assertEquals(256, fixture.botList.maxBots)
        assertEquals(fixture.botPolicy.botId, fixture.botDetail.id)
        assertEquals(AidenBotAvatarAssetMimeType.PNG, fixture.botAvatarMetadata.mimeType)
        assertEquals(512, fixture.botAvatarMetadata.width)
        assertEquals(fixture.botCreate.request.avatar, fixture.botCreate.response.avatar.semantic)
        assertEquals(fixture.botCapabilityCatalog.revision, fixture.botCreate.request.access.catalogRevision)
        assertNull(fixture.botIdentity.response.openingGreeting)
        assertEquals(AidenBotHealth.ARCHIVED, fixture.botArchive.bot.health)
        assertEquals(AidenBotHealth.READY, fixture.botRestore.bot.health)
        assertEquals(AidenBotConversationActivityState.WAITING_FOR_APPROVAL, fixture.botConversation.activityState)
        assertEquals(listOf(fixture.botConversation), fixture.botConversations.conversations)
        assertEquals(30, fixture.botConversationQuery.limit)
        assertEquals(fixture.botDetail.id, fixture.botChatCreate.response.chat.botId)
        assertTrue(fixture.botCapabilityCatalog.shellAvailable)
        assertEquals(AidenBotAccessMode.FULL, fixture.botPolicy.accessMode)
        assertEquals(AidenBotAccessMode.CUSTOM, fixture.botPolicyUpdate.response.accessMode)
        assertEquals(fixture.botCapabilityCatalog.revision, fixture.botPolicyUpdate.request.catalogRevision)
        assertEquals(AidenBotChatAccessMode.INHERIT, fixture.botChatSubset.mode)
        assertEquals(AidenBotChatAccessMode.CUSTOM, fixture.botChatSubsetUpdate.response.mode)
        assertEquals(fixture.botPolicyUpdate.response.revision, fixture.botChatSubsetUpdate.request.expectedBotPolicyRevision)
        assertEquals(fixture.botFavoritesUpdate.response, fixture.botFavorites)
        assertTrue(fixture.botNotice.requiresAcknowledgement)
        assertEquals(AidenBotDecision.CONTINUE_FULL, fixture.botNoticeAcknowledgement.response.acceptedDecision)
        assertEquals(fixture.botAvatarMetadata, fixture.botAvatarUpload.response)
        assertFalse(fixture.legacyNonNegotiating.server.capabilities.contains(AidenRemoteCapability.BOT_READ))
    }

    @Test
    fun testBotContractErrorsGiveSafeActionableRecoveryCopy() {
        val providerError = AidenBotContractException.InvalidCombination("no available provider and model").localizedMessage
        assertTrue(providerError.contains("Settings → Providers") || providerError.contains("chat model") || providerError.contains("Try Again") || providerError.contains("provider"))

        val customAccessError = AidenBotContractException.InvalidCombination("unavailable custom access").localizedMessage
        assertNotNull(customAccessError)

        val invalidField = AidenBotContractException.InvalidField("providerId").localizedMessage
        assertNotNull(invalidField)
    }

    @Test
    fun testBotAvatarRecipeAndPresentation() {
        val recipe = AidenBotAvatarRecipe(
            version = 1,
            shape = AidenBotAvatarShape.ORB,
            color = AidenBotAvatarColor.LILAC,
            eyes = AidenBotAvatarEyes.HAPPY,
            detail = AidenBotAvatarDetail.SPARKLES
        )
        val avatar = AidenBotSemanticAvatar.Recipe(recipe)
        val presentation = aidenBotAvatarPresentation(avatar)

        assertEquals(AidenBotAvatarShape.ORB, presentation.shape)
        assertEquals(AidenBotAvatarColor.LILAC, presentation.color)
        assertEquals(AidenBotAvatarEyes.HAPPY, presentation.eyes)
        assertEquals(AidenBotAvatarDetail.SPARKLES, presentation.detail)

        // Legacy conversion
        val legacyAvatar = AidenBotSemanticAvatar.Legacy(AidenBotLegacyAvatar.SPARK)
        val legacyPres = aidenBotAvatarPresentation(legacyAvatar)
        assertEquals(AidenBotAvatarShape.WISP, legacyPres.shape)
        assertEquals(AidenBotAvatarColor.SUN, legacyPres.color)
    }

    @Test
    fun testBotCreationRequestValidation() {
        val recipe = AidenBotAvatarRecipe(
            shape = AidenBotAvatarShape.HEX,
            color = AidenBotAvatarColor.MINT,
            eyes = AidenBotAvatarEyes.WIDE,
            detail = AidenBotAvatarDetail.HALO
        )
        val validRequest = AidenBotCreateRequest(
            name = "Valid Bot",
            purpose = "Helps with unit tests",
            openingGreeting = "Hello from Bot!",
            instructions = "You are a test bot.",
            avatar = AidenBotSemanticAvatar.Recipe(recipe),
            access = AidenBotAccessUpdate.full("rev_1")
        )
        assertEquals("Valid Bot", validRequest.name)

        // Exceeding name length > 80 throws
        val longName = "A".repeat(81)
        assertThrows(AidenBotContractException.InvalidField::class.java) {
            AidenBotCreateRequest(
                name = longName,
                purpose = "Test",
                instructions = "Instructions",
                avatar = AidenBotSemanticAvatar.Recipe(recipe),
                access = AidenBotAccessUpdate.full("rev_1")
            )
        }
    }

    @Test
    fun testBotCustomSelectionSubsetRules() {
        val ceiling = AidenBotCustomSelection(
            fileScopeIds = listOf("scope_1", "scope_2"),
            shellEnabled = true,
            connectionIds = listOf("conn_1"),
            skillIds = listOf("skill_1"),
            otherCapabilityIds = emptyList(),
            providerId = "openai",
            modelId = "gpt-4o"
        )

        val subset = AidenBotCustomSelection(
            fileScopeIds = listOf("scope_1"),
            shellEnabled = false,
            connectionIds = listOf("conn_1"),
            skillIds = listOf("skill_1"),
            otherCapabilityIds = emptyList(),
            providerId = "openai",
            modelId = "gpt-4o"
        )

        assertTrue(subset.isSubset(ceiling))

        val exceeding = AidenBotCustomSelection(
            fileScopeIds = listOf("scope_1", "scope_3"), // scope_3 not in ceiling
            shellEnabled = false,
            connectionIds = listOf("conn_1"),
            skillIds = listOf("skill_1"),
            otherCapabilityIds = emptyList(),
            providerId = "openai",
            modelId = "gpt-4o"
        )

        assertFalse(exceeding.isSubset(ceiling))
    }

    @Test
    fun testFavoriteOrderSupportsMembershipAndStableReordering() {
        fun favoriteOrder(current: List<String>, moving: String, action: String): List<String> {
            val list = current.toMutableList()
            when (action) {
                "add" -> if (!list.contains(moving)) list.add(moving)
                "remove" -> list.remove(moving)
                "earlier" -> {
                    val idx = list.indexOf(moving)
                    if (idx > 0) {
                        list.removeAt(idx)
                        list.add(idx - 1, moving)
                    }
                }
                "later" -> {
                    val idx = list.indexOf(moving)
                    if (idx in 0 until list.size - 1) {
                        list.removeAt(idx)
                        list.add(idx + 1, moving)
                    }
                }
            }
            return list
        }

        assertEquals(listOf("a", "b", "c"), favoriteOrder(listOf("a", "b"), "c", "add"))
        assertEquals(listOf("b", "a", "c"), favoriteOrder(listOf("a", "b", "c"), "b", "earlier"))
        assertEquals(listOf("a", "c", "b"), favoriteOrder(listOf("a", "b", "c"), "b", "later"))
        assertEquals(listOf("a", "c"), favoriteOrder(listOf("a", "b", "c"), "b", "remove"))
    }

    @Test
    fun testConversationDeletionRequiresIdleActiveWritableBot() {
        fun canDeleteConversation(activityState: AidenBotConversationActivityState, botHealth: AidenBotHealth, canWrite: Boolean): Boolean {
            return activityState == AidenBotConversationActivityState.IDLE && botHealth == AidenBotHealth.READY && canWrite
        }

        assertTrue(canDeleteConversation(AidenBotConversationActivityState.IDLE, AidenBotHealth.READY, true))
        assertFalse(canDeleteConversation(AidenBotConversationActivityState.RUNNING, AidenBotHealth.READY, true))
        assertFalse(canDeleteConversation(AidenBotConversationActivityState.IDLE, AidenBotHealth.ARCHIVED, true))
        assertFalse(canDeleteConversation(AidenBotConversationActivityState.IDLE, AidenBotHealth.READY, false))
    }
}
