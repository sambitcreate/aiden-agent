package sbtbiswas.AidenOnTheGo

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.features.bots.aidenBotAvatarPresentation
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotCustomAccessDraft
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.AidenBotContractException
import sbtbiswas.AidenOnTheGo.protocol.AidenBotPrivateResponseScope
import sbtbiswas.AidenOnTheGo.protocol.AidenBotPrivateResponseValidator
import sbtbiswas.AidenOnTheGo.protocol.AidenRawJsonDuplicateKeyScanner
import sbtbiswas.AidenOnTheGo.networking.AidenSSEParser
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteEventType
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteProtocol
import java.io.File
import java.time.Instant

class AidenBotContractTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun chatReasoningIsAcceptedOnlyForRegularChats() {
        val regular = """{"id":"chat-1","messages":[{"role":"assistant","reasoning":"visible"}]}"""
        val bot = """{"id":"chat-1","botId":"bot-1","messages":[{"role":"assistant","reasoning":"private"}]}"""
        AidenBotPrivateResponseValidator.validate(regular, AidenBotPrivateResponseScope.ChatProjection)
        assertThrows(AidenRemoteContractException.UnsafePayloadField::class.java) {
            AidenBotPrivateResponseValidator.validate(bot, AidenBotPrivateResponseScope.ChatProjection)
        }
    }

    private fun loadSharedContractFixture(): AidenRemoteContractFixture {
        val stream = javaClass.classLoader?.getResourceAsStream("contract.json")
            ?: throw IllegalStateException("Resource contract.json not found")
        val jsonText = stream.bufferedReader().use { it.readText() }
        AidenRawJsonDuplicateKeyScanner.validate(jsonText)
        AidenBotPrivateResponseValidator.validate(
            jsonText,
            AidenBotPrivateResponseScope.SharedFixture
        )
        return json.decodeFromString<AidenRemoteContractFixture>(jsonText)
    }

    @Test
    fun testAndroidContractFixtureMatchesCanonicalRepositoryFixtureByteForByte() {
        val androidFixture = javaClass.classLoader?.getResourceAsStream("contract.json")
            ?.use { it.readBytes() }
            ?: throw AssertionError("Android contract fixture resource not found")
        val canonicalRelativePath = "protocol/aiden-remote/v1/fixtures/contract.json"
        val workingDirectory = System.getProperty("user.dir")
            ?: throw AssertionError("JVM user.dir is unavailable")
        val repositoryRoot = generateSequence(File(workingDirectory).absoluteFile) { it.parentFile }
            .firstOrNull { File(it, canonicalRelativePath).isFile }
            ?: throw AssertionError("Canonical contract fixture not found from $workingDirectory")
        val canonicalFixture = File(repositoryRoot, canonicalRelativePath).readBytes()

        assertArrayEquals(canonicalFixture, androidFixture)
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
    fun testForkSummaryCarriesFocusAndNeverInstructions() {
        fun lineage(summary: String) =
            """{"chatId":"c0","messageId":"m0","position":"after","at":"2026-10-05T12:00:00Z","summary":$summary}"""
        // A chat, a fork result's chat, and a chat list.
        fun chatShapes(lineage: String) = listOf(
            """{"id":"c1","messages":[],"forkedFrom":$lineage}""",
            """{"chat":{"id":"c1","messages":[],"forkedFrom":$lineage}}""",
            """{"chats":[{"id":"c1","messages":[],"forkedFrom":$lineage}]}"""
        )
        val focused = lineage("""{"state":"ready","afterMessageId":"m1","focus":"the parser","text":"Summary"}""")
        for (payload in chatShapes(focused)) {
            AidenBotPrivateResponseValidator.validate(payload, AidenBotPrivateResponseScope.ChatProjection)
        }
        // The pre-release `instructions` name for the focus is private like any other.
        val renamed = lineage("""{"state":"ready","afterMessageId":"m1","instructions":"the parser","text":"Summary"}""")
        for (payload in chatShapes(renamed) + listOf(
            """{"id":"c1","instructions":"leaked","messages":[]}""",
            """{"id":"c1","messages":[{"id":"m1","instructions":"leaked"}]}""",
            """{"id":"c1","messages":[],"forkedFrom":{"chatId":"c0","instructions":"leaked"}}"""
        )) {
            assertThrows("Expected rejection for $payload", AidenRemoteContractException.UnsafePayloadField::class.java) {
                AidenBotPrivateResponseValidator.validate(payload, AidenBotPrivateResponseScope.ChatProjection)
            }
        }
        assertThrows(AidenRemoteContractException.UnsafePayloadField::class.java) {
            AidenBotPrivateResponseValidator.validate(
                """{"summaries":[{"id":"c1","forkedFrom":$renamed}]}""",
                AidenBotPrivateResponseScope.ChatSummaryProjection
            )
        }
    }

    @Test
    fun testPrivateMetadataIsRejectedAtUnknownChildDepth() {
        val rawForbiddenPayloads = listOf(
            """{"message":{"child":{"systemPrompt":"private instructions"}}}""",
            """{"message":{"child":{"absolutePath":"/Users/private/work"}}}""",
            """{"message":{"child":{"providerCredential":"private material"}}}"""
        )
        for (payload in rawForbiddenPayloads) {
            assertThrows(AidenRemoteContractException.UnsafePayloadField::class.java) {
                AidenRawJsonDuplicateKeyScanner.validate(payload)
            }
        }

        val normalizedPrivatePayload = """{"futureChild":{"privateHistory":{"tool.result":"private result"}}}"""
        assertThrows(AidenRemoteContractException.UnsafePayloadField::class.java) {
            AidenBotPrivateResponseValidator.validate(
                normalizedPrivatePayload,
                AidenBotPrivateResponseScope.Root("botDetail")
            )
        }
    }

    @Test
    fun testCheckedInSharedFixtureDecodesEveryBotProjectionDirectly() {
        val fixture = loadSharedContractFixture()

        assertTrue(fixture.contractRevision >= 25)
        // Revision 19 run-control losers learn the winning decision; phones keep
        // their mobile-only grants, so the fixture never offers host capabilities.
        val runControlError = requireNotNull(fixture.runControlError).error
        assertEquals(AidenRemoteErrorCode.APPROVAL_RESOLVED, runControlError.code)
        assertEquals("deny", runControlError.details?.decision)
        assertTrue(fixture.capabilities.none { it.rawValue in setOf("host:events", "runs:observe", "runs:control") })
        assertEquals(listOf(true, false), fixture.workspaces.map { it.memoryEnabled })
        assertEquals(true, fixture.memorySettings?.enabled)
        assertEquals(AidenRemoteProtocol.VERSION, fixture.protocolVersion)
        assertTrue(fixture.server.features.contains(AidenRemoteProtocol.CHAT_SUMMARIES_FEATURE))
        val chatSummaries = requireNotNull(fixture.chatSummaries)
        chatSummaries.validatedWire()
        assertTrue(chatSummaries.summaries.isNotEmpty())
        assertTrue(chatSummaries.summaries.all { it.revision.isNotEmpty() })
        assertEquals(
            listOf("chat_fixture_summary_02", "chat_fixture_summary_01"),
            chatSummaries.summaries.map { it.id }
        )
        assertEquals(AidenChatSummaryActivity.ACTIVE, chatSummaries.summaries.first().activity)
        assertTrue(fixture.server.supportsChatReadState)
        assertEquals(
            listOf(AidenChatRowState.NEEDS_APPROVAL, AidenChatRowState.IDLE),
            chatSummaries.summaries.map { it.displayRowState }
        )
        assertEquals(listOf(false, true), chatSummaries.summaries.map { it.unread })
        assertTrue(requireNotNull(chatSummaries.nextCursor).length <= AidenRemoteProtocol.MAX_CHAT_SUMMARY_CURSOR_LENGTH)
        assertEquals("bot_fixture_01", fixture.botSummary.id)
        assertEquals(256, fixture.botList.maxBots)
        assertEquals(fixture.botPolicy.botId, fixture.botDetail.id)
        assertEquals(AidenBotAvatarAssetMimeType.PNG, fixture.botAvatarMetadata.mimeType)
        assertEquals(512, fixture.botAvatarMetadata.width)
        assertEquals(fixture.botCreate.request.avatar, fixture.botCreate.response.avatar.semantic)
        // Revision 25: access is optional on create (omitted = Full) and a new Bot may need a model.
        assertNull(fixture.botCreate.request.access)
        assertEquals(AidenBotSessionState.NEEDS_MODEL, fixture.botCreate.response.sessionState)
        assertEquals(fixture.botIdentity.request?.purpose, fixture.botIdentity.response.purpose)
        assertEquals(AidenBotConversationActivityState.WAITING_FOR_APPROVAL, fixture.botConversation.activityState)
        assertEquals(listOf(fixture.botConversation), fixture.botConversations.conversations)
        assertEquals(30, fixture.botConversationQuery.limit)
        assertEquals(fixture.botDetail.id, fixture.botChatCreate.response.chat.botId)
        assertTrue(fixture.botCapabilityCatalog.shellAvailable)
        assertEquals(AidenBotAccessMode.FULL, fixture.botPolicy.accessMode)
        assertEquals(AidenBotAccessMode.CUSTOM, fixture.botPolicyUpdate.response.accessMode)
        assertEquals(fixture.botCapabilityCatalog.revision, fixture.botPolicyUpdate.request.catalogRevision)
        assertEquals(fixture.botAvatarMetadata, fixture.botAvatarUpload.response)
        val taskProgress = requireNotNull(fixture.taskProgress)
        val agentRoster = requireNotNull(fixture.agentRoster)
        assertEquals(AidenChatProgressAvailability.READY, taskProgress.availability)
        assertEquals(3, taskProgress.tasks.size)
        assertEquals(AidenChatAgentRole.IMPLEMENTER, agentRoster.agents.first().role)
        assertEquals(2, agentRoster.previousTurns.size)
        assertTrue(fixture.server.supportsChatAgentInterrupt)
        val agentInterrupt = requireNotNull(fixture.agentInterrupt)
        assertEquals(agentRoster.turnId, agentInterrupt.response.turnId)
        assertEquals(
            AidenChatAgentState.STOPPED,
            agentInterrupt.response.agents.single { it.agentId == agentInterrupt.agentId }.state
        )
        assertEquals(2, fixture.chatProgressEvents.size)
        assertEquals(AidenRemoteEventType.TASK_UPDATE, fixture.chatProgressEvents.first().type)
        assertEquals(AidenRemoteEventType.AGENTS_UPDATE, fixture.chatProgressEvents[1].type)
        val streamInput = requireNotNull(fixture.streamInput)
        assertEquals(AidenStreamInputMode.QUEUE, streamInput.request.mode)
        assertEquals(AidenStreamInputStatus.ADMITTED, streamInput.response.status)
        assertEquals(AidenStreamInputQueue.FOLLOW_UP, streamInput.response.queue)
        assertTrue(streamInput.response.committed)
        assertTrue(fixture.server.supportsChatRunInput)
        val questionFixture = requireNotNull(fixture.question)
        val pendingQuestion = AidenQuestionContractCodec.parsePendingQuestion(questionFixture.pending)
        assertEquals("q-fixture-01", pendingQuestion.promptId)
        assertEquals(requireNotNull(fixture.streamStatus).streamId, pendingQuestion.streamId)
        assertEquals(fixture.chat.id, pendingQuestion.chatId)
        assertEquals(1, pendingQuestion.questions.size)
        assertEquals(2, pendingQuestion.questions.first().options.size)
        val respondRequest = AidenQuestionContractCodec.parseRespondRequest(questionFixture.respondRequest)
        assertFalse(respondRequest.cancelled)
        assertEquals(
            listOf(AidenQuestionAnswer.Option(questionIndex = 0, answer = "0.5 mm")),
            respondRequest.answers
        )
        val respondResponse = AidenQuestionContractCodec.parseRespondResponse(questionFixture.respondResponse)
        assertEquals(pendingQuestion.promptId, respondResponse.promptId)
        assertTrue(fixture.server.supportsQuestionPrompts)
        val decodedEvents = fixture.events.map { AidenSSEParser.decodeStreamEvent(it.toString().toByteArray(Charsets.UTF_8)) }
        val questionEvent = decodedEvents.first { it.type == AidenRemoteEventType.QUESTION_REQUIRED }
        assertEquals(pendingQuestion.promptId, questionEvent.payload?.questionPrompt?.promptId)
        assertEquals(pendingQuestion.questions, questionEvent.payload?.questionPrompt?.questions)
        assertFalse(questionEvent.terminal)
        val skillCatalog = AidenSkillContractCodec.parseCatalog(requireNotNull(fixture.chatSkills))
        assertEquals(3, skillCatalog.skills.size)
        assertEquals("review-code", skillCatalog.skills.first().name)
        assertTrue(skillCatalog.skills.first().available)
        assertFalse(skillCatalog.skills[1].available)
        assertNotNull(skillCatalog.skills[1].unavailableReason)
        // A description-less skill is valid wire data; the strict codec must
        // accept the empty string rather than failing the whole catalog.
        assertEquals("triage", skillCatalog.skills[2].name)
        assertEquals("", skillCatalog.skills[2].description)
        assertTrue(skillCatalog.skills[2].available)
        assertTrue(fixture.server.supportsChatSkills)
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
        val recipe = AidenBotAvatarRecipe(version = 1, shape = AidenBotAvatarShape.ORB, color = AidenBotAvatarColor.PLUM)
        val presentation = aidenBotAvatarPresentation(AidenBotSemanticAvatar.Recipe(recipe))
        assertEquals(AidenBotAvatarShape.ORB, presentation.shape)
        assertEquals(AidenBotAvatarColor.PLUM, presentation.color)
    }

    @Test
    fun testBotCreationRequestValidation() {
        val recipe = AidenBotAvatarRecipe(shape = AidenBotAvatarShape.HEX, color = AidenBotAvatarColor.MINT)
        val validRequest = AidenBotCreateRequest(
            name = "Valid Bot",
            purpose = "Helps with unit tests",
            instructions = "You are a test bot.",
            avatar = AidenBotSemanticAvatar.Recipe(recipe)
        )
        assertEquals("Valid Bot", validRequest.name)

        // Exceeding name length > 80 throws
        val longName = "A".repeat(81)
        assertThrows(AidenBotContractException.InvalidField::class.java) {
            AidenBotCreateRequest(
                name = longName,
                purpose = "Test",
                instructions = "Instructions",
                avatar = AidenBotSemanticAvatar.Recipe(recipe)
            )
        }
    }

    @Test
    fun testGloballyDisabledSkillsRejectStaleSelectionsAndAllowSkillFreeChoices() {
        val fixture = loadSharedContractFixture()
        val catalog = fixture.botCapabilityCatalog.copy(skills = emptyList())
        val stale = requireNotNull(fixture.botPolicyUpdate.request.custom)
        assertTrue(stale.skillIds.isNotEmpty())
        assertFalse(catalog.containsAvailable(stale))
        assertTrue(catalog.containsAvailable(stale.copy(skillIds = emptyList())))
    }

    @Test
    fun testDisabledSkillsPreserveSavedDraftsWithoutGrantingNewChoices() {
        val fixture = loadSharedContractFixture()
        val saved = requireNotNull(fixture.botPolicyUpdate.request.custom)
        val catalog = fixture.botCapabilityCatalog.copy(
            skillsEnabled = false,
            skills = fixture.botCapabilityCatalog.skills.map { it.copy(available = false) }
        )
        assertTrue(catalog.containsAvailable(saved))
        val draft = requireNotNull(AidenBotCustomAccessDraft.fromAccess(fixture.botPolicyUpdate.response, catalog))
        assertEquals(saved.skillIds.toSet(), draft.skillIDs)
        assertTrue(draft.isSaveable(catalog))
        assertTrue(requireNotNull(AidenBotCustomAccessDraft.fromCatalog(catalog)).skillIDs.isEmpty())
        assertFalse(catalog.containsAvailable(saved.copy(skillIds = listOf("skill.unknown"))))
        assertFalse(catalog.copy(connections = catalog.connections.map { it.copy(available = false) }).containsAvailable(saved))
        assertFalse(catalog.copy(skillsEnabled = true).containsAvailable(saved))
        assertTrue(fixture.botCapabilityCatalog.containsAvailable(saved))
    }

    @Test
    fun testSkillsGateWireDefaultsAndValidation() {
        val catalog = loadSharedContractFixture().botCapabilityCatalog
        val fields = json.parseToJsonElement(json.encodeToString(AidenBotCapabilityCatalog.serializer(), catalog)).jsonObject
        val legacy = JsonObject(fields - "skillsEnabled")
        assertTrue(json.decodeFromString<AidenBotCapabilityCatalog>(legacy.toString()).skillsEnabled)
        val disabled = JsonObject(fields + ("skillsEnabled" to JsonPrimitive(false)))
        assertFalse(json.decodeFromString<AidenBotCapabilityCatalog>(disabled.toString()).skillsEnabled)
        for (invalid in listOf(JsonNull, JsonPrimitive("false"), JsonPrimitive(0))) {
            assertThrows(Exception::class.java) {
                json.decodeFromString<AidenBotCapabilityCatalog>(JsonObject(fields + ("skillsEnabled" to invalid)).toString())
            }
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

    // --- Contract revision 27 ---

    private fun rawFixture(): JsonObject {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json")) { "contract.json" }
            .bufferedReader().use { it.readText() }
        return json.parseToJsonElement(text).jsonObject
    }

    /** What the client does with a response body: the privacy guard for its route, then the strict decode. */
    private fun <T> asClientReads(root: String, serializer: kotlinx.serialization.KSerializer<T>, element: kotlinx.serialization.json.JsonElement): T {
        AidenBotPrivateResponseValidator.validate(element.toString(), AidenBotPrivateResponseScope.Root(root))
        return AidenBotWireJson.json.decodeFromString(serializer, element.toString())
    }

    @Test
    fun revision27FixturesDecodeThroughTheClientPath() {
        val fixture = rawFixture()
        val memory = asClientReads("botMemory", AidenBotMemory.serializer(), fixture.getValue("botMemory"))
        assertEquals("bot_fixture_01", memory.botId)
        val edit = fixture.getValue("botMemoryEdit").jsonObject
        assertEquals(
            "Prefers short, friendly answers.",
            asClientReads("botMemoryEdit", AidenBotMemoryEditResponse.serializer(), edit.getValue("response")).view.user.entries.first().text
        )
        assertEquals(
            AidenBotRoutineProposalOutcome.ACCEPTED,
            asClientReads(
                "botRoutineProposalRespond",
                AidenBotRoutineProposalRespondResult.serializer(),
                fixture.getValue("botRoutineProposalRespond").jsonObject.getValue("response")
            ).status
        )
        // A suggestion carries the routine's own prompt; the privacy guard lets exactly that through.
        val suggestion = asClientReads("botRoutineSuggestions", AidenBotRoutineSuggestionList.serializer(), fixture.getValue("botRoutineSuggestions"))
        assertTrue(suggestion.suggestions.single().prompt.startsWith("Check in briefly."))
        val feed = asClientReads("botRoutineNotifications", AidenBotRoutineNotificationList.serializer(), fixture.getValue("botRoutineNotifications"))
        assertEquals("Your first meeting is at 9:30 with Priya.", feed.notifications.single().preview)
        val session = asClientReads("botSession", AidenBotSession.serializer(), fixture.getValue("botSessionCards"))
        assertEquals(
            listOf(AidenBotSessionEntry.MemoryUpdate::class, AidenBotSessionEntry.RoutineProposal::class, AidenBotSessionEntry.RoutineProposal::class),
            session.entries.map { it::class }
        )
        // The whole checked-in fixture, revision 27 roots included, passes the shared guard.
        loadSharedContractFixture()
    }

    @Test
    fun aPromptOutsideARoutineCardIsStillRefused() {
        val message = """{"botId":"bot_fixture_01","epoch":"e","seq":1,"state":"idle","interrupted":false,"entries":[{"type":"message","id":"m","role":"assistant","text":"hi","prompt":"leak"}],"hasOlder":false,"question":null,"approval":null}"""
        assertThrows(AidenRemoteContractException.UnsafePayloadField::class.java) {
            AidenBotPrivateResponseValidator.validate(message, AidenBotPrivateResponseScope.Root("botSession"))
        }
        // A model prompt never rides along on a memory view either.
        assertThrows(AidenRemoteContractException.UnsafePayloadField::class.java) {
            AidenBotPrivateResponseValidator.validate("""{"prompt":"x"}""", AidenBotPrivateResponseScope.Root("botMemory"))
        }
    }

    @Test
    fun aSessionSnapshotSkipsEntryTypesThisBuildCannotRead() {
        val session = rawFixture().getValue("botSessionCards").jsonObject
        val entries = session.getValue("entries").jsonArray
        val future = json.parseToJsonElement("""{"type":"mood_ring","id":"entry_25","colour":"teal"}""")
        val withFuture = JsonObject(session + ("entries" to kotlinx.serialization.json.JsonArray(listOf(future) + entries)))
        val decoded = AidenBotWireJson.json.decodeFromString(AidenBotSession.serializer(), withFuture.toString())
        // The unknown entry is dropped; every known one is still there.
        assertEquals(listOf("entry_20", "entry_21", "entry_22"), decoded.entries.map { it.id })

        // Known types stay strict: a malformed memory update still refuses the session.
        val malformed = JsonObject(entries[0].jsonObject + ("text" to JsonPrimitive("Saved")))
        val withMalformed = JsonObject(session + ("entries" to kotlinx.serialization.json.JsonArray(listOf(future, malformed))))
        assertThrows(Exception::class.java) {
            AidenBotWireJson.json.decodeFromString(AidenBotSession.serializer(), withMalformed.toString())
        }
        // An entry without a string `type` is malformed, not unknown.
        val untyped = JsonObject(session + ("entries" to kotlinx.serialization.json.JsonArray(listOf(json.parseToJsonElement("""{"id":"entry_26"}""")))))
        assertThrows(Exception::class.java) {
            AidenBotWireJson.json.decodeFromString(AidenBotSession.serializer(), untyped.toString())
        }
    }

    @Test
    fun anEntryFrameOfAnUnknownTypeIsIgnoredWithoutClosingTheFeed() {
        val stream = """
            data: {"protocolVersion":1,"botId":"bot_fixture_01","epoch":"epoch_fixture_01","seq":4,"type":"entry","payload":{"entry":{"type":"mood_ring","id":"entry_30"}}}

            data: {"protocolVersion":1,"botId":"bot_fixture_01","epoch":"epoch_fixture_01","seq":5,"type":"entry","payload":{"entry":{"type":"memory_update","id":"entry_31"}}}

        """.trimIndent() + "\n"
        val events = kotlinx.coroutines.runBlocking {
            val collected = mutableListOf<AidenBotSessionEvent>()
            AidenBotSessionEventStream.parse(stream.byteInputStream(), "bot_fixture_01").collect { collected += it }
            collected
        }
        assertEquals(2, events.size)
        assertTrue(events[0].payload is AidenBotSessionEventPayload.SkippedEntry)
        assertEquals(AidenBotSessionEntry.MemoryUpdate("entry_31"), (events[1].payload as AidenBotSessionEventPayload.Entry).entry)

        // Applying both keeps the (epoch, seq) chain intact: the skipped frame only advances seq.
        val start = AidenBotWireJson.json.decodeFromString(AidenBotSession.serializer(), rawFixture().getValue("botSessionCards").toString())
        val afterSkip = (sbtbiswas.AidenOnTheGo.features.bots.aidenApplyBotSessionEvent(start, events[0])
            as sbtbiswas.AidenOnTheGo.features.bots.AidenBotSessionEventOutcome.Applied).session
        assertEquals(4L, afterSkip.seq)
        assertEquals(start.entries, afterSkip.entries)
        val afterUpdate = (sbtbiswas.AidenOnTheGo.features.bots.aidenApplyBotSessionEvent(afterSkip, events[1])
            as sbtbiswas.AidenOnTheGo.features.bots.AidenBotSessionEventOutcome.Applied).session
        assertEquals("entry_31", afterUpdate.entries.last().id)

        // A malformed frame of a known type still fails closed.
        val bad = """{"protocolVersion":1,"botId":"bot_fixture_01","epoch":"epoch_fixture_01","seq":6,"type":"entry","payload":{"entry":{"type":"routine_proposal","id":"entry_32"}}}"""
        assertThrows(Exception::class.java) { AidenBotSessionEventStream.decodeFrame(bad.toByteArray(), "bot_fixture_01") }
    }

    @Test
    fun aRetiredOpeningGreetingIsAcceptedAndIgnored() {
        val fixture = rawFixture()
        val detail = fixture.getValue("botDetail").jsonObject
        val plain = AidenBotWireJson.json.decodeFromString(AidenBotDetail.serializer(), detail.toString())
        val legacy = JsonObject(detail + ("openingGreeting" to JsonPrimitive("Hi! I'm Scout.")))
        // An older Mac's greeting passes the Bot detail guard and decodes to the same Bot.
        assertEquals(plain, asClientReads("botDetail", AidenBotDetail.serializer(), legacy))
        // Encoding never writes it back.
        assertFalse(AidenBotWireJson.json.encodeToJsonElement(AidenBotDetail.serializer(), plain).jsonObject.containsKey("openingGreeting"))
        // It must still be a bounded string.
        for (invalid in listOf(JsonPrimitive(3), JsonPrimitive("g".repeat(2_001)))) {
            assertThrows(Exception::class.java) {
                AidenBotWireJson.json.decodeFromString(AidenBotDetail.serializer(), JsonObject(detail + ("openingGreeting" to invalid)).toString())
            }
        }
        // Requests never send it, and an older request shape that names it still reads.
        val createRequest = fixture.getValue("botCreate").jsonObject.getValue("request").jsonObject
        val olderCreate = JsonObject(createRequest + ("openingGreeting" to JsonPrimitive("")))
        val create = AidenBotWireJson.json.decodeFromString(AidenBotCreateRequest.serializer(), olderCreate.toString())
        assertEquals(createRequest, AidenBotWireJson.json.encodeToJsonElement(AidenBotCreateRequest.serializer(), create))
        assertThrows(Exception::class.java) {
            AidenBotWireJson.json.decodeFromString(AidenBotIdentityPatch.serializer(), """{"openingGreeting":"Hi"}""")
        }
    }
}
