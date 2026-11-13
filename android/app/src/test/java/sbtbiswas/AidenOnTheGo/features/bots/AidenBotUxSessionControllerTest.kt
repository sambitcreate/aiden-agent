package sbtbiswas.AidenOnTheGo.features.bots

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.features.remote.aidenBotUxCapabilitiesToRequest
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorEnvelope
import java.io.IOException
import java.time.Instant
import java.util.UUID

/**
 * Revision 61 in a Bot's chat: every answer shows at once, settles with the Mac's answer, and a
 * refusal puts the card back. Only what a typed card's buttons offer is ever sent.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AidenBotUxSessionControllerTest {
    private val wire = AidenBotWireJson.json
    private fun resource(name: String): JsonObject =
        wire.parseToJsonElement(requireNotNull(javaClass.classLoader?.getResourceAsStream(name)).bufferedReader().use { it.readText() }).jsonObject
    private val contract by lazy { resource("contract.json") }
    private val fixture by lazy { resource("bot-ux-revision-61.json") }

    private fun JsonObject.with(vararg pairs: Pair<String, JsonElement>) = JsonObject(this + pairs)

    private fun session(entries: List<JsonObject> = emptyList(), approval: JsonObject? = null): AidenBotSession {
        var raw = contract.getValue("botSession").jsonObject.with("entries" to JsonArray(entries))
        if (approval != null) raw = raw.with("approval" to approval)
        return wire.decodeFromJsonElement(AidenBotSession.serializer(), raw)
    }

    private fun entry(id: String) = fixture.getValue("botSessionEntries").jsonArray.map { it.jsonObject }.single { it.getValue("id").jsonPrimitive.content == id }

    private fun approval(card: String) = JsonObject(
        mapOf(
            "waitId" to JsonPrimitive("wait-61"),
            "toolCallId" to JsonPrimitive("call_61"),
            "toolName" to JsonPrimitive("fetch_url"),
            "summary" to JsonPrimitive("Fetch https://example.com/menu"),
            "canAllow" to JsonPrimitive(true),
            "alwaysCount" to JsonPrimitive(4),
            "card" to fixture.getValue("approvalCards").jsonObject.getValue(card)
        )
    )

    private fun server(status: Int, message: String, code: AidenRemoteErrorCode = AidenRemoteErrorCode.INVALID_REQUEST) =
        AidenRemoteClientException.Server(status, AidenRemoteErrorEnvelope.Body(code, message, "req_1", false))

    private class Transport(var current: AidenBotSession) : AidenBotSessionTransport {
        var gate: CompletableDeferred<Unit>? = null
        var failure: Exception? = null
        val calls = mutableListOf<String>()

        private suspend fun answer(label: String) {
            calls += label
            gate?.await()
            failure?.let { throw it }
        }

        override suspend fun session(botId: String) = current
        override fun events(botId: String): Flow<AidenBotSessionEvent> = emptyFlow()
        override suspend fun send(botId: String, text: String, key: UUID, whenBusy: AidenStreamInputMode?) = throw UnsupportedOperationException()
        override suspend fun resume(botId: String, key: UUID) = throw UnsupportedOperationException()
        override suspend fun dismiss(botId: String, key: UUID) = throw UnsupportedOperationException()
        override suspend fun stop(botId: String, key: UUID) = throw UnsupportedOperationException()
        override suspend fun answerQuestion(botId: String, waitId: String, request: AidenQuestionRespondRequest, key: UUID) = throw UnsupportedOperationException()
        override suspend fun requestConnection(botId: String, pluginId: String, key: UUID) = throw UnsupportedOperationException()
        override suspend fun respondToRoutineProposal(botId: String, proposalId: String, decision: AidenBotRoutineProposalDecision, key: UUID) =
            throw UnsupportedOperationException()

        override suspend fun respondToApproval(waitId: String, decision: AidenApprovalDecision, key: UUID): AidenApprovalResponse {
            answer("approval:${decision.name}:once")
            return AidenApprovalResponse(waitId, decision, resolvedAt = Instant.parse("2026-11-13T09:00:00Z"))
        }

        override suspend fun respondToApproval(waitId: String, decision: AidenApprovalDecision, scope: AidenApprovalScope?, key: UUID): AidenApprovalResponse {
            if (scope == null) return respondToApproval(waitId, decision, key)
            answer("approval:${decision.name}:${scope.name}")
            return AidenApprovalResponse(waitId, decision, resolvedAt = Instant.parse("2026-11-13T09:00:00Z"))
        }

        override suspend fun respondToSettingsChange(botId: String, changeId: String, decision: AidenBotSettingsChangeDecision): AidenBotSettingsChangeRespondResult {
            answer("settings:$changeId:${decision.name}")
            return AidenBotSettingsChangeRespondResult(
                changeId,
                if (decision == AidenBotSettingsChangeDecision.APPLY) AidenBotSettingsChangeStatus.APPLIED else AidenBotSettingsChangeStatus.DISMISSED
            )
        }

        override suspend fun respondToSkillProposal(botId: String, proposalId: String, decision: AidenBotSkillProposalDecision): AidenBotSkillProposalRespondResult {
            answer("skill:$proposalId:${decision.name}")
            return AidenBotSkillProposalRespondResult(proposalId, AidenBotSkillProposalStatus.DISMISSED)
        }
    }

    private fun <T> AidenBotSessionController.entry(id: String): T {
        @Suppress("UNCHECKED_CAST")
        return state.value.session!!.entries.single { it.id == id } as T
    }

    @Test
    fun applyingAHeldChangeShowsAtOnceAndSettlesWithTheMac() = runTest {
        val transport = Transport(session(listOf(entry("entry_fixture_60")))).apply { gate = CompletableDeferred() }
        val controller = AidenBotSessionController(transport.current.botId, transport, backgroundScope)
        controller.refetch()
        val pending = async { controller.respondToSettingsChange("entry_fixture_60", AidenBotSettingsChangeDecision.APPLY) }
        runCurrent()
        assertEquals(AidenBotSettingsChangeStatus.APPLIED, controller.entry<AidenBotSettingsChangeEntry>("entry_fixture_60").status)
        assertTrue("entry_fixture_60" in controller.state.value.uxSending)
        // A second tap while the first is on its way sends nothing.
        assertFalse(controller.respondToSettingsChange("entry_fixture_60", AidenBotSettingsChangeDecision.DISMISS))
        transport.gate!!.complete(Unit)
        assertTrue(pending.await())
        assertEquals(AidenBotSettingsChangeStatus.APPLIED, controller.entry<AidenBotSettingsChangeEntry>("entry_fixture_60").status)
        assertEquals(1, transport.calls.size)
        assertTrue(controller.state.value.uxSending.isEmpty())
    }

    @Test
    fun aFailedAnswerPutsTheCardBackAndARefusalSaysWhy() = runTest {
        for ((failure, message) in listOf(
            IOException("offline") to AidenBotSessionController.SEND_FAILED,
            server(409, "This change is out of date.", AidenRemoteErrorCode.REVISION_CONFLICT) to "This change is out of date."
        )) {
            val transport = Transport(session(listOf(entry("entry_fixture_60")))).apply { this.failure = failure }
            val controller = AidenBotSessionController(transport.current.botId, transport, backgroundScope)
            controller.refetch()
            assertFalse(controller.respondToSettingsChange("entry_fixture_60", AidenBotSettingsChangeDecision.DISMISS))
            val back = controller.entry<AidenBotSettingsChangeEntry>("entry_fixture_60")
            assertEquals(AidenBotSettingsChangeStatus.PENDING, back.status)
            assertTrue(back.awaitsAnswer)
            assertEquals(message, controller.state.value.uxErrors["entry_fixture_60"])
            controller.stopFollowing()
        }
    }

    @Test
    fun aCardTheMacNoLongerHasLeavesTheChat() = runTest {
        val transport = Transport(session(listOf(entry("entry_fixture_62"), entry("entry_fixture_60")))).apply {
            failure = server(404, "Not found", AidenRemoteErrorCode.NOT_FOUND)
        }
        val controller = AidenBotSessionController(transport.current.botId, transport, backgroundScope)
        controller.refetch()
        assertFalse(controller.respondToSkillProposal("entry_fixture_62", AidenBotSkillProposalDecision.DISMISS))
        assertEquals(listOf("entry_fixture_60"), controller.state.value.session!!.entries.map { it.id })
        assertNull(controller.state.value.uxErrors["entry_fixture_62"])
    }

    @Test
    fun aSkillTooLongToReviewHereIsNeverAddedFromThePhone() = runTest {
        val transport = Transport(session(listOf(entry("entry_fixture_66"))))
        val controller = AidenBotSessionController(transport.current.botId, transport, backgroundScope)
        controller.refetch()
        assertFalse(controller.entry<AidenBotSkillProposalEntry>("entry_fixture_66").canAddHere)
        assertFalse(controller.respondToSkillProposal("entry_fixture_66", AidenBotSkillProposalDecision.ADD))
        assertTrue(transport.calls.isEmpty())
        assertTrue(controller.respondToSkillProposal("entry_fixture_66", AidenBotSkillProposalDecision.DISMISS))
        assertEquals(listOf("skill:${controller.entry<AidenBotSkillProposalEntry>("entry_fixture_66").proposalId}:DISMISS"), transport.calls)
    }

    @Test
    fun aTypedCardSendsOnlyWhatItsButtonsOfferAndShowsTheAnsweredLine() = runTest {
        val transport = Transport(session(approval = approval("botAlways"))).apply { gate = CompletableDeferred() }
        val controller = AidenBotSessionController(transport.current.botId, transport, backgroundScope)
        controller.refetch()
        val pending = async { controller.respondToApproval(AidenApprovalDecision.ALLOW, AidenApprovalScope.ALWAYS) }
        runCurrent()
        assertNull(controller.state.value.session!!.approval)
        assertEquals("Always allowed", controller.state.value.answeredApproval?.answered)
        transport.gate!!.complete(Unit)
        assertTrue(pending.await())
        assertEquals(listOf("approval:ALLOW:ALWAYS"), transport.calls)
        assertNotNull(controller.state.value.answeredApproval)
    }

    @Test
    fun aRefusedCardAnswerBringsTheCardBackWithoutTheAnsweredLine() = runTest {
        val transport = Transport(session(approval = approval("botAlways"))).apply { failure = IOException("offline") }
        val controller = AidenBotSessionController(transport.current.botId, transport, backgroundScope)
        controller.refetch()
        assertFalse(controller.respondToApproval(AidenApprovalDecision.ALLOW))
        assertEquals("wait-61", controller.state.value.session!!.approval?.waitId)
        assertNull(controller.state.value.answeredApproval)
        assertEquals(AidenBotSessionController.SEND_FAILED, controller.state.value.actionError)
    }

    @Test
    fun aBotCardNeverShowsAnAllowItsRouteCantSendAndAnUnsendableTapIsSaid() = runTest {
        // A Mac card with Allow once and Allow in this chat: a Bot's route takes once or Always only.
        val macCard = fixture.getValue("streamApprovals").jsonObject.getValue("complete").jsonObject.getValue("card").jsonObject
        val mixed = approval("botAlways").with("card" to macCard)
        val shown = session(approval = mixed).approval!!.card!!
        assertEquals(listOf(null), shown.allowButtons.map { it.scope })
        assertNull(shown.allowOnMac)

        // Only the chat allow: the card is Deny alone and says where to allow it.
        val chatOnly = JsonObject(macCard + ("buttons" to JsonArray(macCard.getValue("buttons").jsonArray.filter {
            it.jsonObject["scope"]?.jsonPrimitive?.content == "chat" || it.jsonObject.getValue("decision").jsonPrimitive.content == "deny"
        })))
        val transport = Transport(session(approval = approval("botAlways").with("card" to chatOnly)))
        val card = transport.current.approval!!.card!!
        assertEquals(listOf("Deny"), card.buttons.map { it.label })
        assertEquals(AidenApprovalCard.ALLOW_ON_MAC, card.allowOnMac)
        val controller = AidenBotSessionController(transport.current.botId, transport, backgroundScope)
        controller.refetch()
        assertFalse(controller.respondToApproval(AidenApprovalDecision.ALLOW, AidenApprovalScope.CHAT))
        assertEquals(AidenBotSessionController.ANSWER_ON_MAC, controller.state.value.actionError)
        assertTrue(transport.calls.isEmpty())
        assertEquals("wait-61", controller.state.value.session!!.approval?.waitId)
    }

    @Test
    fun anExpiredSettledOrSupersededAnswerLeavesNoAnsweredLine() = runTest {
        for (code in listOf(AidenRemoteErrorCode.APPROVAL_EXPIRED, AidenRemoteErrorCode.APPROVAL_ALREADY_RESOLVED)) {
            val transport = Transport(session(approval = approval("botAlways"))).apply { gate = CompletableDeferred(); failure = server(409, "Gone", code) }
            val controller = AidenBotSessionController(transport.current.botId, transport, backgroundScope)
            controller.refetch()
            val pending = async { controller.respondToApproval(AidenApprovalDecision.ALLOW) }
            runCurrent()
            assertEquals("Allowed once", controller.state.value.answeredApproval?.answered)
            transport.gate!!.complete(Unit)
            assertFalse(pending.await())
            // The card does not come back, and neither does a line saying it was answered.
            assertNull(controller.state.value.session!!.approval)
            assertNull(code.toString(), controller.state.value.answeredApproval)
        }

        // The feed reopened while the answer was on its way, then the answer failed.
        val transport = Transport(session(approval = approval("botAlways"))).apply { gate = CompletableDeferred(); failure = IOException("offline") }
        val controller = AidenBotSessionController(transport.current.botId, transport, backgroundScope)
        controller.refetch()
        val pending = async { controller.respondToApproval(AidenApprovalDecision.ALLOW) }
        runCurrent()
        controller.reopenFeed()
        transport.gate!!.complete(Unit)
        assertFalse(pending.await())
        assertNull(controller.state.value.answeredApproval)
    }

    @Test
    fun aCardWithoutAnAllowButtonSendsNoAllow() = runTest {
        val denyOnly = approval("botAlways").let { raw ->
            raw.with("card" to AidenApprovalCard.parse(raw.getValue("card")).denyOnly().toJson())
        }
        val transport = Transport(session(approval = denyOnly))
        val controller = AidenBotSessionController(transport.current.botId, transport, backgroundScope)
        controller.refetch()
        assertFalse(controller.respondToApproval(AidenApprovalDecision.ALLOW))
        assertFalse(controller.respondToApproval(AidenApprovalDecision.ALLOW, AidenApprovalScope.ALWAYS))
        assertTrue(transport.calls.isEmpty())
        assertTrue(controller.respondToApproval(AidenApprovalDecision.DENY))
        assertEquals(listOf("approval:DENY:once"), transport.calls)
    }

    @Test
    fun eachOptInIsAskedForOnlyFromAMacThatOffersItSoAnOldMacKeepsTodaysScreens() {
        val base = listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.BOT_READ, AidenRemoteCapability.BOT_WRITE)
        fun mac(offers: List<AidenRemoteCapability>) = AidenServer(instanceId = "test_instance", name = "Mac", capabilities = base, serverCapabilities = base + offers)
        fun installation(held: List<AidenRemoteCapability>) = AidenInstallation(
            instanceId = "test_instance", deviceId = "test_device", name = "Mac",
            endpoint = "https://aiden.test/api/aiden/v1", serverSpkiSha256 = "sha256/test",
            deviceCapabilities = held, serverCapabilities = held, createdAt = Instant.parse("2026-11-13T09:00:00Z")
        )
        // An older Mac offers none: nothing is asked for and the Bot UX stays off.
        assertTrue(aidenBotUxCapabilitiesToRequest(mac(emptyList()), installation(base)).isEmpty())
        assertFalse(installation(base).offersBotUx)
        // The CLI server offers only approval:cards; the desktop-only four are never asked for.
        assertEquals(listOf(AidenRemoteCapability.APPROVAL_CARDS), aidenBotUxCapabilitiesToRequest(mac(listOf(AidenRemoteCapability.APPROVAL_CARDS)), installation(base)))
        // Already held is not asked for again.
        val all = AidenRemoteCapability.BOT_UX
        assertEquals(all.drop(1), aidenBotUxCapabilitiesToRequest(mac(all), installation(base + all.first())))
        // Without a capability, its session feed grant is absent too.
        assertFalse(AidenRemoteCapability.BOT_SETTINGS_CHANGES in aidenBotSessionFeedGrants(installation(base + AidenRemoteCapability.APPROVAL_CARDS)))
    }
}
