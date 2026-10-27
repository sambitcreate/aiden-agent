package sbtbiswas.AidenOnTheGo.features.bots

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.onCompletion
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sbtbiswas.AidenOnTheGo.features.shared.activitymarks.AidenActivityMarkKind
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorEnvelope
import java.io.IOException
import java.util.UUID

@OptIn(ExperimentalCoroutinesApi::class)
class AidenBotSessionControllerTest {
    @get:Rule
    val tempFolder = TemporaryFolder()

    private val json = AidenBotWireJson.json
    private val fixture: JsonObject by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json"))
            .bufferedReader().use { it.readText() }
        json.parseToJsonElement(text).jsonObject
    }
    private val interruptedSession by lazy { json.decodeFromJsonElement(AidenBotSession.serializer(), fixture.getValue("botSession")) }
    private val needsModelSession by lazy { json.decodeFromJsonElement(AidenBotSession.serializer(), fixture.getValue("botSessionNeedsModel")) }
    private val fixtureEvents by lazy {
        json.decodeFromJsonElement(ListSerializer(AidenBotSessionEvent.serializer()), fixture.getValue("botSessionEvents"))
    }

    private class FakeTransport(var session: AidenBotSession) : AidenBotSessionTransport {
        var sessionReads = 0
        val sends = mutableListOf<Pair<String, UUID>>()
        val resumeKeys = mutableListOf<UUID>()
        var resumeGate: CompletableDeferred<Unit>? = null
        var failNextResume = false

        /** Failures the next session reads throw, in order. */
        val sessionFailures = ArrayDeque<Exception>()
        override suspend fun session(botId: String): AidenBotSession {
            sessionReads += 1
            sessionFailures.removeFirstOrNull()?.let { throw it }
            return session
        }

        /** Feeds the next `events` calls return, in order; then a feed that ends at once. */
        val feeds = ArrayDeque<Flow<AidenBotSessionEvent>>()
        override fun events(botId: String): Flow<AidenBotSessionEvent> = feeds.removeFirstOrNull() ?: emptyFlow()

        /** Failures the next sends throw, in order. */
        val sendFailures = ArrayDeque<Exception>()
        /** The submission ids the next receipts carry, in order; then "1". */
        val receiptIds = ArrayDeque<String>()
        var sendGate: CompletableDeferred<Unit>? = null
        var receiptState = AidenBotSessionState.RUNNING

        val sendModes = mutableListOf<AidenStreamInputMode?>()
        override suspend fun send(botId: String, text: String, key: UUID, whenBusy: AidenStreamInputMode?): AidenBotSessionSendResponse {
            sends += text to key
            sendModes += whenBusy
            sendGate?.await()
            sendFailures.removeFirstOrNull()?.let { throw it }
            return AidenBotSessionSendResponse(receiptIds.removeFirstOrNull() ?: "1", false, receiptState, false)
        }

        override suspend fun resume(botId: String, key: UUID): AidenBotSessionStateView {
            resumeKeys += key
            resumeGate?.await()
            if (failNextResume) {
                failNextResume = false
                throw IOException("offline")
            }
            return AidenBotSessionStateView(AidenBotSessionState.RUNNING, false)
        }

        var dismissGate: CompletableDeferred<Unit>? = null
        val dismissFailures = ArrayDeque<Exception>()
        override suspend fun dismiss(botId: String, key: UUID): AidenBotSessionStateView {
            dismissGate?.await()
            dismissFailures.removeFirstOrNull()?.let { throw it }
            return AidenBotSessionStateView(AidenBotSessionState.IDLE, false)
        }

        val stopKeys = mutableListOf<UUID>()
        var stopGate: CompletableDeferred<Unit>? = null
        val stopFailures = ArrayDeque<Exception>()
        var stopState = AidenBotSessionState.IDLE
        override suspend fun stop(botId: String, key: UUID): AidenBotSessionStateView {
            stopKeys += key
            stopGate?.await()
            stopFailures.removeFirstOrNull()?.let { throw it }
            return AidenBotSessionStateView(stopState, false)
        }

        val answerKeys = mutableListOf<UUID>()
        var failNextAnswer = false
        var answerGate: CompletableDeferred<Unit>? = null

        override suspend fun answerQuestion(
            botId: String,
            waitId: String,
            request: AidenQuestionRespondRequest,
            key: UUID
        ): AidenBotQuestionAnswerReceipt {
            answerKeys += key
            answerGate?.await()
            if (failNextAnswer) {
                failNextAnswer = false
                throw IOException("offline")
            }
            return AidenBotQuestionAnswerReceipt(waitId)
        }
        override suspend fun requestConnection(botId: String, pluginId: String, key: UUID) =
            AidenBotConnectionRequestReceipt(pluginId, "Google Calendar", AidenBotConnectionRequestStatus.SENT)

        data class ApprovalCall(val waitId: String, val decision: AidenApprovalDecision, val key: UUID)
        val approvalCalls = mutableListOf<ApprovalCall>()
        /** Failures the next approval responses throw, in order. */
        val approvalFailures = ArrayDeque<Exception>()
        var approvalGate: CompletableDeferred<Unit>? = null

        override suspend fun respondToApproval(waitId: String, decision: AidenApprovalDecision, key: UUID): AidenApprovalResponse {
            approvalCalls += ApprovalCall(waitId, decision, key)
            approvalGate?.await()
            approvalFailures.removeFirstOrNull()?.let { throw it }
            return AidenApprovalResponse(waitId, decision, resolvedAt = java.time.Instant.parse("2026-08-19T15:02:00Z"))
        }

        data class ProposalCall(val proposalId: String, val decision: AidenBotRoutineProposalDecision, val key: UUID)
        val proposalCalls = mutableListOf<ProposalCall>()
        /** Failures the next proposal answers throw, in order. */
        val proposalFailures = ArrayDeque<Exception>()
        var proposalGate: CompletableDeferred<Unit>? = null

        override suspend fun respondToRoutineProposal(
            botId: String,
            proposalId: String,
            decision: AidenBotRoutineProposalDecision,
            key: UUID
        ): AidenBotRoutineProposalRespondResult {
            proposalCalls += ProposalCall(proposalId, decision, key)
            proposalGate?.await()
            proposalFailures.removeFirstOrNull()?.let { throw it }
            return when (decision) {
                AidenBotRoutineProposalDecision.ACCEPT ->
                    AidenBotRoutineProposalRespondResult(AidenBotRoutineProposalOutcome.ACCEPTED, "task_fixture_routine_03")
                AidenBotRoutineProposalDecision.DISMISS ->
                    AidenBotRoutineProposalRespondResult(AidenBotRoutineProposalOutcome.DISMISSED)
            }
        }
    }

    // --- Revision 27: memory captions and routine proposal cards ---

    private val cardsSession by lazy { json.decodeFromJsonElement(AidenBotSession.serializer(), fixture.getValue("botSessionCards")) }
    private val pendingProposalId = "7d0c5c8e-2f0b-4c4e-9a59-3b6f1f0e9a11"

    private fun AidenBotSessionUiState.proposal(id: String) =
        session!!.entries.filterIsInstance<AidenBotSessionEntry.RoutineProposal>().single { it.proposalId == id }

    @Test
    fun addingAProposedRoutineSettlesTheCardFromTheMacsAnswer() = runTest {
        val transport = FakeTransport(cardsSession)
        val controller = AidenBotSessionController(cardsSession.botId, transport, backgroundScope)
        controller.refetch()

        assertTrue(controller.respondToProposal(pendingProposalId, AidenBotRoutineProposalDecision.ACCEPT))
        val settled = controller.state.value.proposal(pendingProposalId)
        assertEquals(AidenBotRoutineProposalStatus.ACCEPTED, settled.status)
        assertEquals("task_fixture_routine_03", settled.routineId)
        assertEquals(null, controller.state.value.proposalResponses[pendingProposalId])
        // Settled without waiting for the feed: no second read of the session.
        assertEquals(1, transport.sessionReads)
        // A settled card takes no second answer.
        assertFalse(controller.respondToProposal(pendingProposalId, AidenBotRoutineProposalDecision.DISMISS))
        assertEquals(1, transport.proposalCalls.size)
    }

    @Test
    fun notNowSettlesTheCardAsNotAdded() = runTest {
        val transport = FakeTransport(cardsSession)
        val controller = AidenBotSessionController(cardsSession.botId, transport, backgroundScope)
        controller.refetch()

        assertTrue(controller.respondToProposal(pendingProposalId, AidenBotRoutineProposalDecision.DISMISS))
        val settled = controller.state.value.proposal(pendingProposalId)
        assertEquals(AidenBotRoutineProposalStatus.DISMISSED, settled.status)
        assertEquals(null, settled.routineId)
    }

    @Test
    fun aFailedAnswerKeepsTheCardPendingAndARetryReplaysTheSameKey() = runTest {
        val transport = FakeTransport(cardsSession)
        val controller = AidenBotSessionController(cardsSession.botId, transport, backgroundScope)
        controller.refetch()
        transport.proposalFailures += IOException("offline")

        assertFalse(controller.respondToProposal(pendingProposalId, AidenBotRoutineProposalDecision.ACCEPT))
        assertEquals(AidenBotRoutineProposalStatus.PENDING, controller.state.value.proposal(pendingProposalId).status)
        assertEquals(AidenBotProposalPhase.FAILED, controller.state.value.proposalResponses[pendingProposalId])

        // The Mac may have acted before the connection dropped: Add again reuses the key.
        assertTrue(controller.respondToProposal(pendingProposalId, AidenBotRoutineProposalDecision.ACCEPT))
        assertEquals(transport.proposalCalls[0].key, transport.proposalCalls[1].key)
        assertEquals(AidenBotRoutineProposalStatus.ACCEPTED, controller.state.value.proposal(pendingProposalId).status)
    }

    @Test
    fun aProposalTheMacNoLongerHasReloadsTheSession() = runTest {
        val transport = FakeTransport(cardsSession)
        val controller = AidenBotSessionController(cardsSession.botId, transport, backgroundScope)
        controller.refetch()
        transport.proposalFailures += serverError(404, AidenRemoteErrorCode.ROUTINE_PROPOSAL_NOT_FOUND)
        // Meanwhile it was answered on the Mac.
        transport.session = cardsSession.copy(
            entries = cardsSession.entries.map {
                if (it is AidenBotSessionEntry.RoutineProposal && it.proposalId == pendingProposalId) {
                    it.copy(status = AidenBotRoutineProposalStatus.DISMISSED)
                } else it
            }
        )

        assertFalse(controller.respondToProposal(pendingProposalId, AidenBotRoutineProposalDecision.ACCEPT))
        assertEquals(2, transport.sessionReads)
        assertEquals(AidenBotRoutineProposalStatus.DISMISSED, controller.state.value.proposal(pendingProposalId).status)
        assertEquals(null, controller.state.value.proposalResponses[pendingProposalId])
    }

    @Test
    fun backToBackMemoryUpdatesShowAsOneCaption() {
        val update = { id: String -> AidenBotSessionEntry.MemoryUpdate(id) }
        val message = AidenBotSessionEntry.Message("m1", AidenBotMessageRole.ASSISTANT, "Noted.")
        val rows = aidenBotSessionRows(listOf(update("u1"), update("u2"), message, update("u3")))
        assertEquals(
            listOf(
                AidenBotSessionRow.MemoryUpdated(listOf("u1", "u2")),
                AidenBotSessionRow.Entry(message),
                AidenBotSessionRow.MemoryUpdated(listOf("u3"))
            ),
            rows
        )
        // A caption keeps its key as more updates join it, so the row is not recreated.
        val grown = aidenBotSessionRows(listOf(update("u1"), update("u2"), update("u4")))
        assertEquals(rows.first().key, grown.single().key)
        // The fixture's cards: one caption, then both proposal cards.
        assertEquals(
            listOf("memory-entry_20", "entry_21", "entry_22"),
            aidenBotSessionRows(cardsSession.entries).map { it.key }
        )
    }

    @Test
    fun aMemoryUpdateFrameAppendsWithoutClearingTheStreamingReply() = runTest {
        val controller = AidenBotSessionController(cardsSession.botId, FakeTransport(cardsSession), backgroundScope)
        val streaming = cardsSession.copy(state = AidenBotSessionState.RUNNING, partial = "Working on it")
        controller.handle(snapshotOf(streaming))
        val frame = AidenBotSessionEvent(
            streaming.botId, streaming.epoch, streaming.seq + 1,
            AidenBotSessionEventPayload.Entry(AidenBotSessionEntry.MemoryUpdate("entry_23"))
        )
        assertTrue(controller.handle(frame))
        val session = controller.state.value.session!!
        assertEquals("entry_23", session.entries.last().id)
        assertEquals("Working on it", session.partial)
    }

    private val mailApproval = AidenBotApproval(
        waitId = "8d1e2f3a-4b5c-4d6e-9f70-a1b2c3d4e5f6",
        toolCallId = "call_fixture_02",
        toolName = "mcp__mail__send_email",
        summary = "Send an email to dana@example.com: Lunch on Friday?",
        canAllow = true
    )

    private fun approvalController(approval: AidenBotApproval, scope: kotlinx.coroutines.CoroutineScope): Pair<FakeTransport, AidenBotSessionController> {
        val transport = FakeTransport(
            interruptedSession.copy(state = AidenBotSessionState.IDLE, interrupted = false, approval = approval)
        )
        return transport to AidenBotSessionController(transport.session.botId, transport, scope)
    }

    @Test
    fun aWaitingApprovalComesFromTheSnapshotAndFramesAndANullFrameClearsIt() = runTest {
        val controller = AidenBotSessionController(interruptedSession.botId, FakeTransport(interruptedSession), backgroundScope)
        // A snapshot carrying an approval shows it.
        val waiting = interruptedSession.copy(approval = mailApproval)
        assertTrue(controller.handle(snapshotOf(waiting)))
        assertEquals(mailApproval, controller.state.value.session?.approval)

        // The fixture's approval frames, in their own epoch: one appears, the next settles it.
        val approvalFrames = fixtureEvents.filter { it.payload is AidenBotSessionEventPayload.Approval }
        val base = interruptedSession.copy(
            epoch = approvalFrames.first().epoch,
            seq = approvalFrames.first().seq - 1,
            state = AidenBotSessionState.IDLE,
            interrupted = false,
            blocked = null
        )
        assertTrue(controller.handle(snapshotOf(base)))
        assertEquals(null, controller.state.value.session?.approval)
        assertTrue(controller.handle(approvalFrames[0]))
        val shown = controller.state.value.session?.approval
        assertEquals("8d1e2f3a-4b5c-4d6e-9f70-a1b2c3d4e5f6", shown?.waitId)
        assertEquals(true, shown?.canAllow)
        assertTrue(controller.state.value.canStopTurn)
        assertTrue(controller.handle(approvalFrames[1]))
        assertEquals(null, controller.state.value.session?.approval)
        assertEquals(approvalFrames[1].seq, controller.state.value.session?.seq)
        assertFalse("nothing waits on an idle Bot any more", controller.state.value.canStopTurn)
    }

    @Test
    fun anApprovalDecisionIsRetriedUnderOneKeyAndClearsWhenTheMacAnswers() = runTest {
        val (transport, controller) = approvalController(mailApproval, backgroundScope)
        controller.refetch()

        transport.approvalFailures += IOException("offline")
        assertFalse(controller.respondToApproval(AidenApprovalDecision.ALLOW))
        assertEquals("an unanswered attempt keeps the card", mailApproval, controller.state.value.session?.approval)
        assertTrue(controller.respondToApproval(AidenApprovalDecision.ALLOW))

        assertEquals(
            listOf(mailApproval.waitId, mailApproval.waitId),
            transport.approvalCalls.map { it.waitId }
        )
        assertEquals(listOf(AidenApprovalDecision.ALLOW, AidenApprovalDecision.ALLOW), transport.approvalCalls.map { it.decision })
        assertEquals("the retry replays the first attempt", transport.approvalCalls[0].key, transport.approvalCalls[1].key)
        assertEquals(null, controller.state.value.session?.approval)
        assertFalse(controller.state.value.isRespondingToApproval)
        assertFalse("nothing is waiting any more", controller.respondToApproval(AidenApprovalDecision.DENY))
        assertEquals(2, transport.approvalCalls.size)
    }

    @Test
    fun theOtherDecisionAfterAnUnansweredAttemptGetsANewKey() = runTest {
        val (transport, controller) = approvalController(mailApproval, backgroundScope)
        controller.refetch()
        transport.approvalFailures += IOException("offline")
        assertFalse(controller.respondToApproval(AidenApprovalDecision.ALLOW))
        assertTrue(controller.respondToApproval(AidenApprovalDecision.DENY))
        assertEquals(listOf(AidenApprovalDecision.ALLOW, AidenApprovalDecision.DENY), transport.approvalCalls.map { it.decision })
        assertNotEquals("another decision is another request", transport.approvalCalls[0].key, transport.approvalCalls[1].key)
    }

    @Test
    fun aDenyOnlyApprovalRefusesAllowAndStillSendsDeny() = runTest {
        val (transport, controller) = approvalController(mailApproval.copy(canAllow = false), backgroundScope)
        controller.refetch()
        assertFalse(controller.respondToApproval(AidenApprovalDecision.ALLOW))
        assertTrue("Allow never reaches the Mac", transport.approvalCalls.isEmpty())
        assertTrue(controller.respondToApproval(AidenApprovalDecision.DENY))
        assertEquals(listOf(AidenApprovalDecision.DENY), transport.approvalCalls.map { it.decision })
    }

    @Test
    fun anExpiredOrAlreadySettledApprovalIsCleared() = runTest {
        val (transport, controller) = approvalController(mailApproval, backgroundScope)
        controller.refetch()
        transport.approvalFailures += serverError(409, AidenRemoteErrorCode.APPROVAL_EXPIRED)
        assertFalse(controller.respondToApproval(AidenApprovalDecision.ALLOW))
        assertEquals(null, controller.state.value.session?.approval)
        assertTrue(controller.state.value.actionError != null)

        // Settled on the Mac or another phone: the card goes away without an error.
        controller.refetch()
        assertEquals(mailApproval, controller.state.value.session?.approval)
        transport.approvalFailures += serverError(409, AidenRemoteErrorCode.APPROVAL_ALREADY_RESOLVED)
        assertFalse(controller.respondToApproval(AidenApprovalDecision.DENY))
        assertEquals(null, controller.state.value.session?.approval)
        assertEquals(null, controller.state.value.actionError)

        // A refusal the Mac answered (capability_denied) keeps the card and ends that attempt's key.
        controller.refetch()
        transport.approvalFailures += serverError(403, AidenRemoteErrorCode.CAPABILITY_DENIED)
        assertFalse(controller.respondToApproval(AidenApprovalDecision.ALLOW))
        assertEquals(mailApproval, controller.state.value.session?.approval)
        assertTrue(controller.respondToApproval(AidenApprovalDecision.ALLOW))
        assertNotEquals(transport.approvalCalls[2].key, transport.approvalCalls[3].key)
    }

    @Test
    fun aSecondTapWhileADecisionIsInFlightSendsNothing() = runTest {
        val (transport, controller) = approvalController(mailApproval, backgroundScope)
        controller.refetch()
        val gate = CompletableDeferred<Unit>()
        transport.approvalGate = gate
        val first = async { controller.respondToApproval(AidenApprovalDecision.ALLOW) }
        // Held, not timed out: the clock stays short of the request limit.
        runCurrent()
        assertTrue(controller.state.value.isRespondingToApproval)
        assertFalse(controller.respondToApproval(AidenApprovalDecision.DENY))
        assertEquals(1, transport.approvalCalls.size)
        gate.complete(Unit)
        assertTrue(first.await())
        assertFalse(controller.state.value.isRespondingToApproval)
    }

    private val colourQuestion = AidenBotQuestion(
        waitId = "5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c",
        toolCallId = "call_1",
        questions = listOf(
            AidenRemoteQuestion(
                question = "Which colour should the banner use?",
                header = "Colour",
                multiSelect = false,
                options = listOf(
                    AidenRemoteQuestionOption("Blue", "Calm and cool."),
                    AidenRemoteQuestionOption("Red", "Loud and warm.")
                )
            )
        )
    )

    @Test
    fun aQuestionAnswerIsRetriedUnderOneKeyAndClearsWhenTheMacReceipts() = runTest {
        val transport = FakeTransport(
            interruptedSession.copy(state = AidenBotSessionState.IDLE, interrupted = false, question = colourQuestion)
        )
        val controller = AidenBotSessionController(transport.session.botId, transport, backgroundScope)
        controller.refetch()
        val answer = AidenQuestionRespondRequest(false, listOf(AidenQuestionAnswer.Option(0, "Blue")))

        transport.failNextAnswer = true
        assertFalse(controller.answerQuestion(answer))
        assertTrue(controller.answerQuestion(answer))

        assertEquals("the retry reuses the key of the failed attempt", 2, transport.answerKeys.size)
        assertEquals(transport.answerKeys[0], transport.answerKeys[1])
        assertEquals(null, controller.state.value.session?.question)
        assertFalse(controller.state.value.isAnsweringQuestion)
        assertFalse("nothing is waiting any more", controller.answerQuestion(answer))
        assertEquals(2, transport.answerKeys.size)
    }

    @Test
    fun aDifferentAnswerAfterAFailureGetsANewKey() = runTest {
        val transport = FakeTransport(
            interruptedSession.copy(state = AidenBotSessionState.IDLE, interrupted = false, question = colourQuestion)
        )
        val controller = AidenBotSessionController(transport.session.botId, transport, backgroundScope)
        controller.refetch()
        transport.failNextAnswer = true
        assertFalse(controller.answerQuestion(AidenQuestionRespondRequest(false, listOf(AidenQuestionAnswer.Option(0, "Blue")))))
        assertTrue(controller.answerQuestion(AidenQuestionRespondRequest(false, listOf(AidenQuestionAnswer.Option(0, "Red")))))
        assertEquals(2, transport.answerKeys.size)
        assertNotEquals("another answer is another request", transport.answerKeys[0], transport.answerKeys[1])
    }

    @Test
    fun doubleResumeSendsOneRequestAndARetryReusesItsKey() = runTest {
        val transport = FakeTransport(interruptedSession)
        val controller = AidenBotSessionController(interruptedSession.botId, transport, backgroundScope)
        controller.refetch()

        // Two taps while the first Resume is in flight send one request.
        val gate = CompletableDeferred<Unit>()
        transport.resumeGate = gate
        transport.failNextResume = true
        val first = async { controller.resume() }
        val second = async { controller.resume() }
        runCurrent()
        assertEquals(1, transport.resumeKeys.size)
        assertFalse(second.await())
        gate.complete(Unit)
        assertFalse(first.await())
        assertTrue(controller.state.value.isInterrupted)

        // The failed Resume is retried with the same Idempotency-Key.
        transport.resumeGate = null
        assertTrue(controller.resume())
        assertEquals(2, transport.resumeKeys.size)
        assertEquals(transport.resumeKeys[0], transport.resumeKeys[1])
        assertEquals(AidenBotSessionState.RUNNING, controller.state.value.state)

        // A later, separate Resume of another pause is a new logical action with a new key.
        controller.refetch()
        controller.resume()
        assertNotEquals(transport.resumeKeys[1], transport.resumeKeys[2])
    }

    @Test
    fun aPresetBotThatNeedsAModelShowsItAndSendsNothing() = runTest {
        val preset = json.decodeFromJsonElement(
            AidenBotPresetCreateResult.serializer(),
            fixture.getValue("botPresetCreate").jsonObject.getValue("response")
        )
        val transport = FakeTransport(needsModelSession)
        val controller = AidenBotSessionController(preset.bot.id, transport, backgroundScope, knownState = preset.bot.sessionState)

        // Before the session loads, the home list's state already marks the chat.
        assertTrue(controller.state.value.needsModel)
        assertFalse(controller.state.value.canSend)
        assertFalse(controller.send("Plan my week"))

        controller.refetch()
        assertTrue(controller.state.value.needsModel)
        assertFalse(controller.send("Plan my week"))
        assertTrue(transport.sends.isEmpty())
    }

    /**
     * Revision 41: an image the Bot shared is read from the Mac when it is drawn, once while the
     * chat is open; a failed read is tried again, and an id the transcript doesn't hold is never asked for.
     */
    @Test
    fun aSharedImageIsReadOnceAndAFailedReadIsTriedAgain() = runTest {
        val image = AidenBotSessionEntry.SharedImage(id = "entry_7", name = "chart.png", mimeType = "image/png", size = 4)
        val withImage = needsModelSession.copy(state = AidenBotSessionState.IDLE, entries = listOf(image))
        val bytes = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47)
        val transport = object : AidenBotSessionTransport by FakeTransport(withImage) {
            val reads = mutableListOf<String>()
            var held: ByteArray? = null
            override suspend fun session(botId: String) = withImage
            override suspend fun sharedImage(botId: String, entryId: String): ByteArray {
                reads += entryId
                return held ?: throw IOException("offline")
            }
        }
        val controller = AidenBotSessionController(withImage.botId, transport, backgroundScope)
        controller.refetch()

        assertNull("the Mac couldn't send it yet", controller.sharedImageData(image.id))
        transport.held = bytes
        assertTrue(bytes.contentEquals(controller.sharedImageData(image.id)))
        assertTrue(bytes.contentEquals(controller.sharedImageData(image.id)))
        assertEquals("one failed read, then one read kept for the chat", listOf(image.id, image.id), transport.reads)

        assertNull(controller.sharedImageData("entry_99"))
        assertEquals("an id the transcript doesn't hold never reaches the Mac", 2, transport.reads.size)
    }

    /**
     * Revision 41: shared images stay within a byte budget. The oldest drawn image is dropped and
     * read again when it is drawn next; an image the transcript no longer shows is dropped; closing
     * the chat lets every image go.
     */
    @Test
    fun sharedImagesStayWithinTheirBudgetAndAreReadAgainAfterBeingDropped() = runTest {
        fun image(id: String) = AidenBotSessionEntry.SharedImage(id = id, name = "$id.png", mimeType = "image/png", size = 4)
        var shown = needsModelSession.copy(state = AidenBotSessionState.IDLE, entries = listOf(image("entry_1"), image("entry_2"), image("entry_3")))
        val transport = object : AidenBotSessionTransport by FakeTransport(shown) {
            val reads = mutableListOf<String>()
            override suspend fun session(botId: String) = shown
            override suspend fun sharedImage(botId: String, entryId: String): ByteArray {
                reads += entryId
                return ByteArray(4) { entryId.last().code.toByte() }
            }
        }
        // Room for two 4-byte images.
        val controller = AidenBotSessionController(shown.botId, transport, backgroundScope, sharedImageBudgetBytes = 8)
        controller.refetch()

        controller.sharedImageData("entry_1")
        controller.sharedImageData("entry_2")
        controller.sharedImageData("entry_1")
        assertEquals("both fit, so the second draw of entry_1 is kept", listOf("entry_1", "entry_2"), transport.reads)
        controller.sharedImageData("entry_3")
        controller.sharedImageData("entry_2")
        assertEquals(
            "entry_3 pushed out the least recently drawn image, entry_2, which is read again",
            listOf("entry_1", "entry_2", "entry_3", "entry_2"),
            transport.reads
        )
        assertTrue(ByteArray(4) { '2'.code.toByte() }.contentEquals(controller.sharedImageData("entry_2")))

        // entry_2 leaves the transcript: once another image is read, it is no longer kept.
        shown = shown.copy(entries = listOf(image("entry_3"), image("entry_4")))
        controller.refetch()
        controller.sharedImageData("entry_4")
        assertNull("an image the transcript no longer shows is not read", controller.sharedImageData("entry_2"))

        controller.stopFollowing()
        controller.sharedImageData("entry_3")
        assertEquals("closing the chat dropped what it held", "entry_3", transport.reads.last())
    }

    /** The viewer caches pictures app-wide by attachment id, so the same entry id in two Bots draws two pictures. */
    @Test
    fun sharedImagesOfTwoBotsNeverShareAViewerId() = runTest {
        val image = AidenBotSessionEntry.SharedImage(id = "entry_7", name = "chart.png", mimeType = "image/png", size = 4)
        val one = AidenBotSessionController("bot-one", FakeTransport(needsModelSession), backgroundScope)
        val two = AidenBotSessionController("bot-two", FakeTransport(needsModelSession), backgroundScope)
        val first = one.sharedImageAttachment(image)
        val second = two.sharedImageAttachment(image)
        assertNotEquals(first.id, second.id)
        assertEquals(first.id, one.sharedImageAttachment(image).id)
        assertTrue("the viewer still accepts the id", first.isWireSafe && second.isWireSafe)
        val otherMac = AidenBotSessionController(
            "bot-one", FakeTransport(needsModelSession), backgroundScope,
            sessionKey = AidenBotSessionKey("instance-b", "device-b", "bot-one")
        )
        assertNotEquals(first.id, otherMac.sharedImageAttachment(image).id)
    }

    @Test
    fun aLostSendKeepsItsKeyAndGoesOutAgainWhileConnected() = runTest {
        val idle = needsModelSession.copy(state = AidenBotSessionState.IDLE)
        val transport = object : AidenBotSessionTransport by FakeTransport(idle) {
            val keys = mutableListOf<UUID>()
            var fail = true
            override suspend fun session(botId: String) = idle
            override suspend fun send(botId: String, text: String, key: UUID, whenBusy: AidenStreamInputMode?): AidenBotSessionSendResponse {
                keys += key
                if (fail) {
                    fail = false
                    throw IOException("offline")
                }
                return AidenBotSessionSendResponse("1", false, AidenBotSessionState.RUNNING, false)
            }
        }
        val controller = AidenBotSessionController(idle.botId, transport, backgroundScope)
        controller.refetch()
        assertTrue("the bubble shows at once, even when the request is lost", controller.send("Plan my week"))
        assertEquals(1, transport.keys.size)
        assertEquals(AidenBotOutgoingLook.Sending, controller.state.value.look(controller.state.value.outgoing.single()))
        advanceTimeBy(1_001)
        runCurrent()
        assertEquals(2, transport.keys.size)
        assertEquals("the Mac may hold the first attempt: the same key", transport.keys[0], transport.keys[1])
        assertEquals(AidenBotOutgoingStatus.SENT, controller.state.value.outbox.single().status)
    }

    @Test
    fun liveEventsApplyInOrderAndAnEpochChangeOrSeqGapRefetches() = runTest {
        val transport = FakeTransport(interruptedSession)
        val controller = AidenBotSessionController(interruptedSession.botId, transport, backgroundScope)
        val snapshot = fixtureEvents[0]
        val partial = fixtureEvents[1]
        val entry = fixtureEvents[2]
        val state = fixtureEvents[3]
        val closed = fixtureEvents[4]
        val newEpoch = fixtureEvents[5]

        assertTrue(controller.handle(snapshot))
        assertTrue(controller.handle(partial))
        assertEquals("Your first meeting is at 9:30", controller.state.value.session?.partial)
        // A replay of an already-applied seq is ignored.
        assertTrue(controller.handle(partial))
        assertEquals(0, transport.sessionReads)
        assertTrue(controller.handle(entry))
        assertEquals(null, controller.state.value.session?.partial)
        assertEquals("entry_13", controller.state.value.session?.entries?.last()?.id)
        assertTrue(controller.handle(state))
        assertEquals(AidenBotSessionBlock.ACCESS_CHANGED, controller.state.value.session?.blocked)
        // `closed` asks for a reconnect, not a refetch.
        assertFalse(controller.handle(closed))
        assertEquals(0, transport.sessionReads)

        // A frame from a new epoch discards local state and refetches the session.
        assertTrue(controller.handle(newEpoch))
        assertEquals(1, transport.sessionReads)

        // So does a gap in the sequence within the known epoch.
        val known = requireNotNull(controller.state.value.session)
        val gap = AidenBotSessionEvent(known.botId, known.epoch, known.seq + 2, AidenBotSessionEventPayload.Partial("skip"))
        assertTrue(controller.handle(gap))
        assertEquals(2, transport.sessionReads)
        assertEquals(interruptedSession, controller.state.value.session)
    }

    @Test
    fun eventRuleIsPureAboutEpochAndSequence() {
        val session = interruptedSession
        fun at(epoch: String, seq: Long) =
            aidenApplyBotSessionEvent(session, AidenBotSessionEvent(session.botId, epoch, seq, AidenBotSessionEventPayload.Partial("x")))
        assertTrue(at(session.epoch, session.seq + 1) is AidenBotSessionEventOutcome.Applied)
        assertEquals(AidenBotSessionEventOutcome.Ignored, at(session.epoch, session.seq))
        assertEquals(AidenBotSessionEventOutcome.Refetch, at(session.epoch, session.seq + 3))
        assertEquals(AidenBotSessionEventOutcome.Refetch, at("another_epoch", session.seq + 1))
        assertEquals(AidenBotSessionEventOutcome.Refetch, aidenApplyBotSessionEvent(null, fixtureEvents[1]))
    }

    @Test
    fun onlyANewAssistantAnswerClearsTheStreamingText() {
        val streaming = interruptedSession.copy(partial = "Working on it")
        fun apply(entry: AidenBotSessionEntry) = (aidenApplyBotSessionEvent(
            streaming,
            AidenBotSessionEvent(streaming.botId, streaming.epoch, streaming.seq + 1, AidenBotSessionEventPayload.Entry(entry))
        ) as AidenBotSessionEventOutcome.Applied).session

        val card = AidenBotSessionEntry.ConnectCard(
            id = "card_mid_turn", pluginId = "gmail", name = "Gmail", iconId = "gmail",
            reason = "Read your inbox", status = AidenBotConnectCardStatus.PENDING
        )
        assertEquals("Working on it", apply(card).partial)

        val existing = streaming.entries.last { it is AidenBotSessionEntry.Message } as AidenBotSessionEntry.Message
        assertEquals("Working on it", apply(existing.copy(text = "edited in place")).partial)

        val answer = existing.copy(id = "answer_new", role = AidenBotMessageRole.ASSISTANT, text = "Done")
        assertEquals(null, apply(answer).partial)
    }

    private fun serverError(status: Int, code: AidenRemoteErrorCode = AidenRemoteErrorCode.NOT_FOUND) =
        AidenRemoteClientException.Server(status, AidenRemoteErrorEnvelope.Body(code, "Nope.", "req_1", false))

    private fun snapshotOf(session: AidenBotSession) =
        AidenBotSessionEvent(session.botId, session.epoch, session.seq, AidenBotSessionEventPayload.Snapshot(session))

    @Test
    fun aMidStreamSnapshotReplacesEverythingAndAnEntryUpsertsById() = runTest {
        val controller = AidenBotSessionController(interruptedSession.botId, FakeTransport(interruptedSession), backgroundScope)
        assertTrue(controller.handle(fixtureEvents[0]))
        assertTrue(controller.handle(fixtureEvents[1]))
        assertEquals("Your first meeting is at 9:30", controller.state.value.session?.partial)

        // An empty partial clears the in-flight text.
        val s0 = requireNotNull(controller.state.value.session)
        assertTrue(controller.handle(AidenBotSessionEvent(s0.botId, s0.epoch, s0.seq + 1, AidenBotSessionEventPayload.Partial(""))))
        assertEquals(null, controller.state.value.session?.partial)

        // Re-sending an existing id changes it in place instead of appending a copy.
        val s1 = requireNotNull(controller.state.value.session)
        val last = s1.entries.last() as AidenBotSessionEntry.Message
        val cutOff = last.copy(text = "cut off", interrupted = true)
        assertTrue(controller.handle(AidenBotSessionEvent(s1.botId, s1.epoch, s1.seq + 1, AidenBotSessionEventPayload.Entry(cutOff))))
        val after = requireNotNull(controller.state.value.session)
        assertEquals(s1.entries.size, after.entries.size)
        assertEquals(cutOff, after.entries.last())

        // A snapshot mid-stream (history rewritten on the Mac) replaces entries, partial,
        // state and seq.
        val rewritten = interruptedSession.copy(
            seq = after.seq + 5,
            state = AidenBotSessionState.IDLE,
            interrupted = false,
            partial = null,
            entries = interruptedSession.entries.take(2)
        )
        assertTrue(controller.handle(snapshotOf(rewritten)))
        assertEquals(rewritten, controller.state.value.session)
        // Live events then continue from the snapshot's seq.
        assertTrue(controller.handle(AidenBotSessionEvent(rewritten.botId, rewritten.epoch, rewritten.seq + 1, AidenBotSessionEventPayload.Partial("Next"))))
        assertEquals("Next", controller.state.value.session?.partial)
    }

    @Test
    fun aGapKeepsTheChatOnScreenAndAFailedRefetchReopensTheFeed() = runTest {
        var reads = 0
        val transport = object : AidenBotSessionTransport by FakeTransport(interruptedSession) {
            override suspend fun session(botId: String): AidenBotSession {
                reads += 1
                throw IOException("offline")
            }
        }
        val controller = AidenBotSessionController(interruptedSession.botId, transport, backgroundScope)
        controller.handle(fixtureEvents[0])
        val gap = AidenBotSessionEvent(interruptedSession.botId, interruptedSession.epoch, interruptedSession.seq + 4, AidenBotSessionEventPayload.Partial("x"))
        assertFalse(controller.handle(gap))
        assertEquals(1, reads)
        assertEquals(interruptedSession, controller.state.value.session)
        assertFalse(controller.state.value.loadFailed)
    }

    @Test
    fun theFeedReconnectsAfterADropOrCloseAndStopsForADeletedBot() = runTest {
        val idle = interruptedSession.copy(state = AidenBotSessionState.IDLE, interrupted = false, partial = null)
        var opens = 0
        val transport = object : AidenBotSessionTransport by FakeTransport(interruptedSession) {
            override fun events(botId: String): Flow<AidenBotSessionEvent> = flow {
                opens += 1
                when (opens) {
                    1 -> {
                        emit(fixtureEvents[0])
                        throw IOException("dropped")
                    }
                    2 -> {
                        emit(snapshotOf(idle))
                        emit(AidenBotSessionEvent(idle.botId, idle.epoch, idle.seq + 1, AidenBotSessionEventPayload.Closed))
                        awaitCancellation()
                    }
                    else -> throw serverError(404)
                }
            }
        }
        val controller = AidenBotSessionController(interruptedSession.botId, transport, backgroundScope, reconnectDelayMillis = 100)
        controller.start()
        advanceTimeBy(1_000); runCurrent()
        assertEquals(3, opens)
        assertTrue(controller.state.value.botMissing)
        assertFalse(controller.state.value.canSend)
        // The last good snapshot stays on screen, and nothing reconnects any more.
        assertEquals(idle, controller.state.value.session)
        advanceTimeBy(10_000)
        assertEquals(3, opens)
    }

    @Test
    fun leavingTheScreenCancelsTheFeed() = runTest {
        var cancelled = false
        val transport = object : AidenBotSessionTransport by FakeTransport(interruptedSession) {
            override fun events(botId: String): Flow<AidenBotSessionEvent> =
                flow<AidenBotSessionEvent> { awaitCancellation() }.onCompletion { cancelled = it != null }
        }
        val controller = AidenBotSessionController(interruptedSession.botId, transport, backgroundScope)
        controller.start()
        runCurrent()
        assertFalse(cancelled)
        controller.stopFollowing()
        runCurrent()
        assertTrue(cancelled)
    }

    @Test
    fun aResumeTheMacRefusedIsFinishedSoTheNextTapIsANewRequest() = runTest {
        val keys = mutableListOf<UUID>()
        var refuse = true
        val transport = object : AidenBotSessionTransport by FakeTransport(interruptedSession) {
            override suspend fun resume(botId: String, key: UUID): AidenBotSessionStateView {
                keys += key
                if (refuse) {
                    refuse = false
                    throw serverError(409, AidenRemoteErrorCode.REVISION_CONFLICT)
                }
                return AidenBotSessionStateView(AidenBotSessionState.RUNNING, false)
            }
        }
        val controller = AidenBotSessionController(interruptedSession.botId, transport, backgroundScope)
        controller.refetch()
        assertFalse(controller.resume())
        assertEquals("Aiden couldn’t reach your Mac. Try again.", controller.state.value.actionError)
        assertTrue(controller.resume())
        assertNotEquals(keys[0], keys[1])
    }

    @Test
    fun aConnectionRequestForAnUnknownPluginFailsAndCanBeRetried() = runTest {
        val keys = mutableListOf<UUID>()
        var known = false
        val transport = object : AidenBotSessionTransport by FakeTransport(interruptedSession) {
            override suspend fun requestConnection(botId: String, pluginId: String, key: UUID): AidenBotConnectionRequestReceipt {
                keys += key
                if (!known) throw serverError(404)
                return AidenBotConnectionRequestReceipt(pluginId, "Google Calendar", AidenBotConnectionRequestStatus.SENT)
            }
        }
        val controller = AidenBotSessionController(interruptedSession.botId, transport, backgroundScope)
        controller.requestConnection("google-calendar")
        assertEquals(AidenBotConnectRequestPhase.FAILED, controller.state.value.connectRequests["google-calendar"])
        known = true
        controller.requestConnection("google-calendar")
        assertEquals(AidenBotConnectRequestPhase.SENT, controller.state.value.connectRequests["google-calendar"])
        assertNotEquals(keys[0], keys[1])
        // A second tap after it was sent posts nothing.
        controller.requestConnection("google-calendar")
        assertEquals(2, keys.size)
    }

    private val failedTurns by lazy {
        json.decodeFromJsonElement(ListSerializer(AidenBotSessionEntry.serializer()), fixture.getValue("botSessionFailedTurns"))
            .map { it as AidenBotSessionEntry.FailedTurn }
    }

    /** An idle session whose newest entries are [tail]. */
    private fun sessionEndingWith(vararg tail: AidenBotSessionEntry) =
        interruptedSession.copy(
            state = AidenBotSessionState.IDLE,
            interrupted = false,
            blocked = null,
            partial = null,
            entries = interruptedSession.entries + tail
        )

    @Test
    fun retryResendsTheFailedTurnsTextAsANewSubmissionWithAFreshKey() = runTest {
        val failed = failedTurns[0]
        val transport = FakeTransport(sessionEndingWith(failed))
        val controller = AidenBotSessionController(transport.session.botId, transport, backgroundScope)
        controller.refetch()
        // The original message went out under its own key.
        assertTrue(controller.send("Plan my week, please."))

        assertEquals(failed, controller.state.value.retryableFailedTurn)
        assertTrue(controller.retry())

        assertEquals(listOf("Plan my week, please.", "Plan my week, please."), transport.sends.map { it.first })
        assertNotEquals("a retry never reuses the original message's key", transport.sends[0].second, transport.sends[1].second)
        assertEquals(AidenBotSessionState.RUNNING, controller.state.value.state)
        assertFalse(controller.state.value.isSending)
    }

    @Test
    fun aLostRetryKeepsItsKeyUntilTheMacIsBackAndARefusedOneGetsANewKey() = runTest {
        val first = failedTurns[0]
        val transport = FakeTransport(sessionEndingWith(first))
        val controller = AidenBotSessionController(transport.session.botId, transport, backgroundScope)
        controller.refetch()

        // Retry goes through the outbox (R18): it shows at once, and a lost request keeps its key.
        transport.sendFailures += IOException("offline")
        assertTrue(controller.retry())
        assertEquals(first.retryText, controller.state.value.outgoing.single().text)
        assertNull("no second Retry while one is on its way", controller.state.value.retryableFailedTurn)
        assertFalse(controller.retry())
        advanceTimeBy(1_001)
        runCurrent()
        assertEquals("the backoff replays the lost retry", transport.sends[0].second, transport.sends[1].second)

        // The Mac refused the next one outright: Try again is a new request.
        transport.session = sessionEndingWith(first.copy(id = "entry_20:failed"))
        controller.refetch()
        transport.sendFailures += serverError(400, AidenRemoteErrorCode.INVALID_REQUEST)
        assertTrue(controller.retry())
        val failed = controller.state.value.outbox.single { it.retryOf == "entry_20:failed" }
        assertEquals(AidenBotOutgoingLook.Failed, controller.state.value.look(failed))
        assertTrue(controller.retry())
        assertEquals(4, transport.sends.size)
        assertNotEquals(transport.sends[2].second, transport.sends[3].second)
        assertTrue("every failed turn has its own retry", transport.sends.take(2).none { it.second == transport.sends[3].second })
        assertEquals("one bubble for the retried message", 1, controller.state.value.outbox.count { it.retryOf == "entry_20:failed" })
    }

    @Test
    fun onlyTheNewestFailedTurnWithTextCanBeRetried() = runTest {
        val withText = failedTurns[0]
        val withoutText = failedTurns[1]
        val laterMessage = AidenBotSessionEntry.Message("entry_15", AidenBotMessageRole.USER, "Something else")

        for (session in listOf(sessionEndingWith(withText, laterMessage), sessionEndingWith(withoutText))) {
            val transport = FakeTransport(session)
            val controller = AidenBotSessionController(session.botId, transport, backgroundScope)
            controller.refetch()
            assertEquals(null, controller.state.value.retryableFailedTurn)
            assertFalse(controller.retry())
            assertTrue(transport.sends.isEmpty())
        }

        // Not while the Bot needs an AI model.
        val noModel = sessionEndingWith(withText).copy(state = AidenBotSessionState.NEEDS_MODEL)
        val transport = FakeTransport(noModel)
        val controller = AidenBotSessionController(noModel.botId, transport, backgroundScope)
        controller.refetch()
        assertFalse(controller.retry())
        assertTrue(transport.sends.isEmpty())
    }

    @Test
    fun stopStaysAvailableWhileAQuestionCardIsUp() = runTest {
        val transport = FakeTransport(sessionEndingWith().copy(question = colourQuestion))
        val controller = AidenBotSessionController(transport.session.botId, transport, backgroundScope)
        controller.refetch()
        assertFalse(controller.state.value.isRunning)
        assertTrue(controller.state.value.canStopTurn)

        transport.session = sessionEndingWith()
        controller.refetch()
        assertFalse("an idle Bot with nothing waiting has nothing to stop", controller.state.value.canStopTurn)
        transport.session = sessionEndingWith().copy(state = AidenBotSessionState.RUNNING)
        controller.refetch()
        assertTrue(controller.state.value.canStopTurn)
    }

    private fun conversation(chatId: String, botId: String, updatedAt: String) = AidenBotConversationItem(
        chatId = chatId,
        botId = botId,
        title = "Chat",
        activityState = AidenBotConversationActivityState.IDLE,
        canRespondToApproval = false,
        createdAt = java.time.Instant.parse("2026-08-01T00:00:00Z"),
        updatedAt = java.time.Instant.parse(updatedAt),
        revision = "r1"
    )

    @Test
    fun filesOpenOnThisBotsConversation() {
        val conversations = listOf(
            conversation("chat_other", "bot_other", "2026-08-03T00:00:00Z"),
            conversation("chat_old", "bot_1", "2026-08-01T00:00:00Z"),
            conversation("chat_new", "bot_1", "2026-08-02T00:00:00Z")
        )
        assertEquals("chat_new", aidenBotFilesChatId("bot_1", conversations))
        assertEquals("chat_other", aidenBotFilesChatId("bot_other", conversations))
        assertEquals(null, aidenBotFilesChatId("bot_missing", conversations))
        assertEquals(null, aidenBotFilesChatId("bot_1", emptyList()))
    }

    @Test
    fun sendingWhileInterruptedIsAllowedAndTheMacsStateReplacesThePause() = runTest {
        val transport = FakeTransport(interruptedSession)
        val controller = AidenBotSessionController(interruptedSession.botId, transport, backgroundScope)
        controller.refetch()
        assertTrue(controller.state.value.isInterrupted)
        assertTrue(controller.state.value.canSend)
        assertTrue(controller.send("  Never mind, plan lunch  "))
        assertEquals(listOf("Never mind, plan lunch"), transport.sends.map { it.first })
        assertFalse(controller.state.value.isInterrupted)
        assertEquals(AidenBotSessionState.RUNNING, controller.state.value.state)
    }

    // --- Revision 30: the status line, Reconnecting, Queued and Steer/Queue ---

    private val activitySession by lazy {
        json.decodeFromJsonElement(AidenBotSession.serializer(), fixture.getValue("botActivity").jsonObject.getValue("session"))
    }
    private val started = 1_760_450_000_000L

    private fun ui(
        session: AidenBotSession,
        supported: Boolean = true,
        wording: AidenBotChatActivityWording = AidenBotChatActivityWording.FOLLOWS
    ) = AidenBotSessionUiState(session = session, isLoading = false, activitySupported = supported, wording = wording)

    // Test 1 (R7: the line hides only while reply text streams with no tool at work)
    @Test
    fun theLineShowsUntilTheReplyStreamsAndFollowsTheChosenWording() {
        val line = aidenBotStatusLine(ui(activitySession), started + 1_000)!!
        assertEquals(AidenBotActivityPhase.APP, line.display.phase)
        assertEquals("Notion", line.display.app)
        val thinking = AidenBotChatActivityWording.THINKING
        assertEquals(AidenBotActivityPhase.THINKING, aidenBotStatusLine(ui(activitySession, wording = thinking), started)!!.display.phase)
        val waiting = activitySession.copy(activity = AidenBotSessionActivity("waiting", null, started))
        assertEquals(AidenBotActivityPhase.WAITING, aidenBotStatusLine(ui(waiting, wording = thinking), started)!!.display.phase)
        val writing = activitySession.copy(partial = "Here is", activity = AidenBotSessionActivity("writing", null, started))
        assertNull("the reply's words are the signal", aidenBotStatusLine(ui(writing), started))
        assertNull(aidenBotStatusLine(ui(activitySession.copy(partial = "Here is", activity = null)), started))
        // Narration text that outlasts the words into a tool call keeps the line, as on the Mac.
        assertEquals(
            AidenBotActivityPhase.APP,
            aidenBotStatusLine(ui(activitySession.copy(partial = "Let me check Notion")), started)!!.display.phase
        )
        assertEquals(
            "whitespace is not a reply",
            AidenBotActivityPhase.WRITING,
            aidenBotStatusLine(ui(writing.copy(partial = "  ")), started)!!.display.phase
        )
        assertNull(aidenBotStatusLine(ui(activitySession.copy(state = AidenBotSessionState.IDLE)), started))
    }

    // Test 2 (Review Focus 3)
    @Test
    fun anUnknownPhaseReadsAsWorkingAndElapsedShowsAfterTwentySeconds() {
        val browsing = activitySession.copy(activity = AidenBotSessionActivity("browsing", null, started))
        val early = aidenBotStatusLine(ui(browsing), started + 19_000)!!
        assertEquals(AidenBotActivityPhase.WORKING, early.display.phase)
        assertEquals(AidenActivityMarkKind.QUAD_SHUFFLE, early.display.mark)
        assertNull(early.elapsed)
        assertEquals("1m 12s", aidenBotStatusLine(ui(browsing), started + 72_000)!!.elapsed)
        assertNull("a phone clock behind the Mac's shows no time", aidenBotStatusLine(ui(browsing), started - 60_000)!!.elapsed)
    }

    // Test 3
    @Test
    fun beforeTheFirstActivityFrameItSaysGettingReadyAndOlderMacsShowNothing() {
        assertEquals(
            AidenBotActivityPhase.PREPARING,
            aidenBotStatusLine(ui(activitySession.copy(activity = null)), started)!!.display.phase
        )
        assertNull(aidenBotStatusLine(ui(activitySession, supported = false), started))
        assertFalse(ui(activitySession, supported = false).offersBusyModes)
    }

    // Test 4 (Review Focus 2)
    @Test
    fun aDroppedFeedReadsReconnectingUntilTheNextFrame() = runTest {
        val transport = FakeTransport(activitySession)
        transport.feeds += flow { throw IOException("Wi-Fi dropped") }
        val reopened = activitySession.copy(
            epoch = "epoch_fixture_03",
            seq = 1,
            activity = AidenBotSessionActivity("searching", null, started)
        )
        transport.feeds += flow {
            emit(AidenBotSessionEvent(reopened.botId, reopened.epoch, reopened.seq, AidenBotSessionEventPayload.Snapshot(reopened)))
            awaitCancellation()
        }
        val controller = AidenBotSessionController(
            activitySession.botId, transport, backgroundScope, activitySupported = true, reconnectDelayMillis = 1_000
        )
        controller.start()
        runCurrent()
        assertTrue(controller.state.value.streamDown)
        assertEquals(AidenBotActivityPhase.RECONNECTING, aidenBotStatusLine(controller.state.value, started)!!.display.phase)

        advanceTimeBy(1_001)
        runCurrent()
        assertFalse(controller.state.value.streamDown)
        assertEquals(AidenBotActivityPhase.SEARCHING, aidenBotStatusLine(controller.state.value, started)!!.display.phase)
        controller.stopFollowing()
    }

    // Test 5
    @Test
    fun steerAndQueueGoOutOnlyWhileTheBotWorksOnAMacThatOffersThem() = runTest {
        val transport = FakeTransport(activitySession)
        val supported = AidenBotSessionController(activitySession.botId, transport, backgroundScope, activitySupported = true)
        supported.refetch()
        assertTrue(supported.state.value.offersBusyModes)
        assertTrue(supported.send("Keep it vegetarian.", AidenStreamInputMode.STEER))
        val older = AidenBotSessionController(activitySession.botId, transport, backgroundScope)
        older.refetch()
        assertTrue(older.send("Also a list.", AidenStreamInputMode.QUEUE))
        // An idle Bot on a Mac that offers them takes no mode either.
        transport.session = activitySession.copy(state = AidenBotSessionState.IDLE, activity = null, queued = emptyList())
        val idle = AidenBotSessionController(activitySession.botId, transport, backgroundScope, activitySupported = true)
        idle.refetch()
        assertTrue(idle.send("Thanks.", AidenStreamInputMode.STEER))
        assertEquals("an older Mac would refuse whenBusy", listOf(AidenStreamInputMode.STEER, null, null), transport.sendModes)
    }

    // Test 6
    @Test
    fun queuedAndActivityFramesFoldIntoTheSessionInSeqOrder() {
        val waiting = listOf(AidenBotQueuedMessage("18", AidenStreamInputMode.QUEUE, "Also add a shopping list."))
        fun at(seq: Long, payload: AidenBotSessionEventPayload) =
            AidenBotSessionEvent(activitySession.botId, activitySession.epoch, seq, payload)
        val queued = aidenApplyBotSessionEvent(activitySession, at(activitySession.seq + 1, AidenBotSessionEventPayload.Queued(waiting)))
        val afterQueued = (queued as AidenBotSessionEventOutcome.Applied).session
        assertEquals(waiting, afterQueued.queued)
        val cleared = aidenApplyBotSessionEvent(afterQueued, at(afterQueued.seq + 1, AidenBotSessionEventPayload.Activity(null)))
        assertNull((cleared as AidenBotSessionEventOutcome.Applied).session.activity)
        val gap = aidenApplyBotSessionEvent(afterQueued, at(afterQueued.seq + 2, AidenBotSessionEventPayload.Activity(null)))
        assertEquals(AidenBotSessionEventOutcome.Refetch, gap)
    }

    // --- R14 / R16 / R17: the optimistic outbox ---

    private suspend fun AidenBotSessionController.frame(payload: AidenBotSessionEventPayload): Boolean {
        val s = state.value.session!!
        return handle(AidenBotSessionEvent(s.botId, s.epoch, s.seq + 1, payload))
    }

    private fun userEntry(id: String, text: String, submissionId: String? = null) =
        AidenBotSessionEntry.Message(id, AidenBotMessageRole.USER, text, submissionId = submissionId)

    /** The running fixture turn with nothing queued, so each test sets its own queue. */
    private val runningSession by lazy { activitySession.copy(queued = emptyList()) }

    @Test
    fun identicalTextsSettleExactlyByTheirSubmissionIds() = runTest {
        val transport = FakeTransport(runningSession)
        transport.receiptIds += listOf("21", "22")
        val controller = AidenBotSessionController(runningSession.botId, transport, backgroundScope, activitySupported = true)
        controller.refetch()
        assertTrue(controller.send("Yes."))
        assertTrue(controller.send("Yes."))
        assertEquals(2, controller.state.value.outgoing.size)

        // The second message's entry lands first: only that bubble gives way.
        controller.frame(AidenBotSessionEventPayload.Entry(userEntry("entry_41", "Yes.", "22")))
        assertEquals(listOf("21"), controller.state.value.outgoing.map { it.submissionId })
        // An unrelated frame changes nothing.
        controller.frame(AidenBotSessionEventPayload.Partial("Sure"))
        assertEquals(1, controller.state.value.outgoing.size)
        controller.frame(AidenBotSessionEventPayload.Entry(userEntry("entry_42", "Yes.", "21")))
        assertTrue(controller.state.value.outgoing.isEmpty())
        assertTrue(controller.state.value.outbox.isEmpty())
    }

    @Test
    fun onAnOlderMacEachEntrySettlesOneBubbleOnceByItsText() = runTest {
        val transport = FakeTransport(runningSession)
        val controller = AidenBotSessionController(runningSession.botId, transport, backgroundScope)
        controller.refetch()
        assertTrue(controller.send("Yes."))
        assertTrue(controller.send("Yes."))
        controller.frame(AidenBotSessionEventPayload.Entry(userEntry("entry_41", "Yes.")))
        assertEquals("one entry stands for one message", 1, controller.state.value.outgoing.size)
        // A later frame never lets the same entry settle the other message too.
        controller.frame(AidenBotSessionEventPayload.State(AidenBotSessionStateView(AidenBotSessionState.RUNNING, false)))
        assertEquals(1, controller.state.value.outgoing.size)
        controller.frame(AidenBotSessionEventPayload.Entry(userEntry("entry_42", "Yes.")))
        assertTrue(controller.state.value.outgoing.isEmpty())
    }

    @Test
    fun aDeferredMessageHoldsBackTheOnesBehindIt() = runTest {
        val transport = FakeTransport(runningSession)
        val controller = AidenBotSessionController(runningSession.botId, transport, backgroundScope)
        controller.refetch()
        transport.sendFailures += IOException("dropped")
        assertTrue(controller.send("First"))
        assertTrue(controller.send("Second"))
        assertEquals("nothing overtakes the deferred head", listOf("First"), transport.sends.map { it.first })
        assertEquals(listOf("First", "Second"), controller.state.value.outgoing.map { it.text })
        advanceTimeBy(1_001)
        runCurrent()
        assertEquals(listOf("First", "First", "Second"), transport.sends.map { it.first })
        assertEquals(transport.sends[0].second, transport.sends[1].second)
    }

    @Test
    fun aMessageThatKeepsFailingSaysSoKeepsItsKeyAndTryAgainReplaysIt() = runTest {
        val transport = FakeTransport(runningSession)
        val controller = AidenBotSessionController(runningSession.botId, transport, backgroundScope)
        controller.refetch()
        transport.sendFailures += listOf(
            IOException("one"),
            serverError(503, AidenRemoteErrorCode.INTERNAL_ERROR),
            serverError(409, AidenRemoteErrorCode.IDEMPOTENCY_IN_FLIGHT)
        )
        assertTrue(controller.send("Plan lunch"))
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(3, transport.sends.size)
        assertEquals("every ambiguous failure keeps the key", 1, transport.sends.map { it.second }.toSet().size)
        val failed = controller.state.value.outgoing.single()
        assertEquals("never dropped", AidenBotOutgoingLook.Failed, controller.state.value.look(failed))

        assertTrue(controller.retrySend(failed.id))
        assertEquals(transport.sends[0].second, transport.sends[3].second)
        assertEquals(AidenBotOutgoingStatus.SENT, controller.state.value.outbox.single().status)
        assertEquals("the bubble keeps its identity", failed.id, controller.state.value.outbox.single().id)
    }

    @Test
    fun aRefusedMessageFailsTryAgainUsesANewKeyAndOnlyAFailedOneCanBeRemoved() = runTest {
        val transport = FakeTransport(runningSession)
        val controller = AidenBotSessionController(runningSession.botId, transport, backgroundScope)
        controller.refetch()
        transport.sendFailures += serverError(400, AidenRemoteErrorCode.INVALID_REQUEST)
        assertTrue(controller.send("Plan lunch"))
        val failed = controller.state.value.outgoing.single()
        assertEquals(AidenBotOutgoingStatus.FAILED, failed.status)
        transport.sendFailures += serverError(400, AidenRemoteErrorCode.INVALID_REQUEST)
        assertTrue(controller.retrySend(failed.id))
        assertNotEquals(transport.sends[0].second, transport.sends[1].second)

        transport.sendGate = CompletableDeferred()
        val another = async { controller.send("Another") }
        runCurrent()
        controller.discardSend(controller.state.value.outbox.last().id)
        assertEquals("an unsettled message is never removed", 2, controller.state.value.outbox.size)
        controller.discardSend(failed.id)
        assertEquals(listOf("Another"), controller.state.value.outbox.map { it.text })
        transport.sendGate!!.complete(Unit)
        assertTrue(another.await())
    }

    @Test
    fun messagesSentBeforeConnectingShowAtOnceAndGoOutOnLoad() = runTest {
        val transport = FakeTransport(runningSession)
        val controller = AidenBotSessionController(runningSession.botId, transport, backgroundScope, activitySupported = true)
        assertTrue(controller.state.value.isConnecting)
        assertTrue(controller.send("Plan lunch"))
        assertTrue(transport.sends.isEmpty())
        assertEquals(listOf("Plan lunch"), controller.state.value.outgoing.map { it.text })
        assertEquals(
            "the line says Getting ready before the Mac does",
            AidenBotActivityPhase.PREPARING,
            aidenBotStatusLine(controller.state.value.copy(knownState = AidenBotSessionState.IDLE), started)!!.display.phase
        )
        controller.refetch()
        runCurrent()
        assertEquals(listOf("Plan lunch"), transport.sends.map { it.first })
        assertFalse(controller.state.value.isConnecting)
    }

    @Test
    fun aQueuedMessageReadsQueuedOnlyWhenSentWhileTheBotWorksAndTheMacsBubbleReplacesIt() = runTest {
        val transport = FakeTransport(runningSession)
        transport.receiptIds += "23"
        val controller = AidenBotSessionController(runningSession.botId, transport, backgroundScope, activitySupported = true)
        controller.refetch()
        transport.sendGate = CompletableDeferred()
        val sending = async { controller.send("Also a list.", AidenStreamInputMode.STEER) }
        runCurrent()
        val bubble = controller.state.value.outgoing.single()
        assertEquals(AidenBotOutgoingLook.Queued(AidenStreamInputMode.STEER), controller.state.value.look(bubble))
        // The Mac's Queued frame beats the receipt: one bubble, the Mac's.
        controller.frame(AidenBotSessionEventPayload.Queued(listOf(AidenBotQueuedMessage("23", AidenStreamInputMode.STEER, "Also a list."))))
        assertTrue(controller.state.value.outgoing.isEmpty())
        transport.sendGate!!.complete(Unit)
        assertTrue(sending.await())
        assertTrue(controller.state.value.outgoing.isEmpty())
        // The turn takes it in: the queue empties, and until its entry lands it shows plainly.
        controller.frame(AidenBotSessionEventPayload.Queued(emptyList()))
        assertEquals(AidenBotOutgoingLook.Sent, controller.state.value.look(controller.state.value.outgoing.single()))
        controller.frame(AidenBotSessionEventPayload.Entry(userEntry("entry_43", "Also a list.", "23")))
        assertTrue(controller.state.value.outbox.isEmpty())

        // Sent while idle, it never reads Queued, even once the turn it started runs.
        transport.session = runningSession.copy(seq = 50, state = AidenBotSessionState.IDLE, activity = null)
        controller.refetch()
        transport.receiptState = AidenBotSessionState.RUNNING
        transport.sendGate = CompletableDeferred()
        val idleSend = async { controller.send("Plan lunch") }
        runCurrent()
        controller.frame(AidenBotSessionEventPayload.State(AidenBotSessionStateView(AidenBotSessionState.RUNNING, false)))
        assertEquals(AidenBotOutgoingLook.Sending, controller.state.value.look(controller.state.value.outgoing.single()))
        transport.sendGate!!.complete(Unit)
        idleSend.await()
    }

    @Test
    fun anOlderMacNeverShowsQueuedOrTheLine() = runTest {
        val transport = FakeTransport(runningSession)
        val controller = AidenBotSessionController(runningSession.botId, transport, backgroundScope)
        controller.refetch()
        transport.sendGate = CompletableDeferred()
        val sending = async { controller.send("Also a list.") }
        runCurrent()
        assertEquals(AidenBotOutgoingLook.Sending, controller.state.value.look(controller.state.value.outgoing.single()))
        assertNull(aidenBotStatusLine(controller.state.value, started))
        transport.sendGate!!.complete(Unit)
        sending.await()
        assertEquals(AidenBotOutgoingLook.Sent, controller.state.value.look(controller.state.value.outgoing.single()))
    }

    @Test
    fun aReceiptDoesNotRollBackNewerFrames() = runTest {
        val idle = runningSession.copy(state = AidenBotSessionState.IDLE, activity = null)
        val transport = FakeTransport(idle)
        val controller = AidenBotSessionController(idle.botId, transport, backgroundScope)
        controller.refetch()
        transport.sendGate = CompletableDeferred()
        val sending = async { controller.send("Plan lunch") }
        runCurrent()
        // The turn already ran and finished on the Mac before the receipt (RUNNING) arrives.
        controller.frame(AidenBotSessionEventPayload.State(AidenBotSessionStateView(AidenBotSessionState.RUNNING, false)))
        controller.frame(AidenBotSessionEventPayload.State(AidenBotSessionStateView(AidenBotSessionState.IDLE, false)))
        transport.sendGate!!.complete(Unit)
        sending.await()
        assertEquals(AidenBotSessionState.IDLE, controller.state.value.state)
    }

    private fun store(root: java.io.File, clock: () -> Long, maxBytes: Int = AidenBotSessionStore.MAX_BYTES) =
        AidenBotSessionStore(root, io = { it.run() }, nowMs = clock, maxBytes = maxBytes)

    private val chatKey = AidenBotSessionKey("instance_fixture_01", "device_fixture_01", "bot_fixture_01")

    @Test
    fun anOutboxOutlivesLeavingTheChatAndProcessDeathAndGoesOutUnderItsKey() = runTest {
        val root = tempFolder.newFolder()
        var clock = started
        val transport = FakeTransport(runningSession)
        val first = store(root, { clock })
        val leaving = AidenBotSessionController(
            runningSession.botId, transport, backgroundScope, sessionKey = chatKey, store = first, nowMs = { clock }
        )
        assertTrue(leaving.send("Plan lunch"))
        val key = leaving.state.value.outbox.single().key
        // Left before the disk was even read: the messages wait in the store, not lost.
        leaving.stopFollowing()
        val offline = object : AidenBotSessionTransport by transport {
            override suspend fun session(botId: String): AidenBotSession = throw IOException("offline")
        }
        val early = AidenBotSessionController(
            runningSession.botId, offline, backgroundScope, sessionKey = chatKey, store = first, nowMs = { clock }
        )
        early.start()
        runCurrent()
        assertEquals(listOf("Plan lunch"), early.state.value.outgoing.map { it.text })
        early.stopFollowing()

        // Back to the chat in the same run: shown at once, from memory.
        val back = AidenBotSessionController(
            runningSession.botId, transport, backgroundScope, sessionKey = chatKey, store = first, nowMs = { clock }
        )
        assertEquals(listOf("Plan lunch"), back.state.value.outgoing.map { it.text })
        // The chat left behind can no longer write it.
        assertFalse(first.storeOutbox(chatKey, leaving, emptyList()))
        back.stopFollowing()

        // The process died: a new store reads it from disk, off the main thread, before anything goes out.
        clock += 60_000
        val relaunched = AidenBotSessionController(
            runningSession.botId, transport, backgroundScope, sessionKey = chatKey, store = store(root, { clock }), nowMs = { clock }
        )
        assertTrue("nothing is read during composition", relaunched.state.value.outbox.isEmpty())
        assertTrue(relaunched.send("And dinner"))
        relaunched.refetch()
        runCurrent()
        assertEquals("the older message goes first", listOf("Plan lunch", "And dinner"), relaunched.state.value.outbox.map { it.text })
        assertEquals(listOf("Plan lunch", "And dinner"), transport.sends.map { it.first })
        assertEquals("under the key it was given before the process died", key, transport.sends[0].second)
    }

    @Test
    fun aRestoreForAnotherPairingIsRefused() = runTest {
        val root = tempFolder.newFolder()
        val transport = FakeTransport(runningSession)
        val first = store(root, { started })
        val controller = AidenBotSessionController(runningSession.botId, transport, backgroundScope, sessionKey = chatKey, store = first)
        assertTrue(controller.send("Plan lunch"))
        runCurrent()
        // The same chat after a re-pair (another deviceId) finds this file where its own would be.
        val repaired = chatKey.copy(deviceId = "device_fixture_02")
        val theirs = first.fileFor(repaired)!!
        theirs.parentFile!!.mkdirs()
        first.fileFor(chatKey)!!.copyTo(theirs)
        val other = AidenBotSessionController(
            runningSession.botId, transport, backgroundScope, sessionKey = repaired, store = store(root, { started })
        )
        other.start()
        runCurrent()
        assertTrue(other.state.value.outbox.isEmpty())
        assertFalse("the misplaced file is moved out of the way", theirs.exists())
        assertEquals("set aside, never deleted", 1, theirs.parentFile!!.listFiles()!!.count { it.name.endsWith(".unreadable") })
        assertEquals(AidenBotSessionNotice.OUTBOX_UNRESTORABLE, other.state.value.notice)
        other.stopFollowing()
    }

    @Test
    fun aControllerThatLostTheChatToAnotherStopsSending() = runTest {
        val sessions = AidenBotSessionStore(null, io = { it.run() })
        val transport = FakeTransport(runningSession)
        val older = AidenBotSessionController(runningSession.botId, transport, backgroundScope, sessionKey = chatKey, store = sessions)
        older.refetch()
        runCurrent()
        AidenBotSessionController(runningSession.botId, transport, backgroundScope, sessionKey = chatKey, store = sessions)
        assertTrue(older.send("From the old screen"))
        assertTrue("its write was refused, so it sends nothing", transport.sends.isEmpty())
    }

    @Test
    fun leavingTheChatCancelsTheRequestUnderWayAndTheNextVisitReplaysItsKey() = runTest {
        val sessions = AidenBotSessionStore(null, io = { it.run() })
        val transport = FakeTransport(runningSession)
        val controller = AidenBotSessionController(runningSession.botId, transport, backgroundScope, sessionKey = chatKey, store = sessions)
        controller.refetch()
        runCurrent()
        transport.sendGate = CompletableDeferred()
        val sending = async { controller.send("Plan lunch") }
        runCurrent()
        controller.stopFollowing()
        runCurrent()
        assertTrue(sending.isCompleted)
        assertEquals(AidenBotOutgoingStatus.SENDING, controller.state.value.outbox.single().status)
        transport.sendGate = null
        val next = AidenBotSessionController(runningSession.botId, transport, backgroundScope, sessionKey = chatKey, store = sessions)
        next.refetch()
        runCurrent()
        assertEquals(2, transport.sends.size)
        assertEquals("the same request again", transport.sends[0].second, transport.sends[1].second)
        assertEquals(AidenBotOutgoingStatus.SENT, next.state.value.outbox.single().status)
    }

    @Test
    fun aMessageThatWouldOverflowTheStoredOutboxIsRefusedNotWritten() = runTest {
        val root = tempFolder.newFolder()
        val transport = FakeTransport(runningSession)
        val controller = AidenBotSessionController(
            runningSession.botId, transport, backgroundScope, sessionKey = chatKey, store = store(root, { started }, maxBytes = 1_500)
        )
        val text = "x".repeat(400)
        var taken = 0
        while (controller.send(text) && taken < 20) taken += 1
        runCurrent()
        assertTrue("some fit, then one was refused", taken in 1..5)
        assertEquals(AidenBotSessionNotice.OUTBOX_FULL, controller.state.value.notice)
        assertEquals(taken, controller.state.value.outbox.size)
        // What was kept reads back whole.
        val relaunched = AidenBotSessionController(
            runningSession.botId, transport, backgroundScope, sessionKey = chatKey, store = store(root, { started }, maxBytes = 1_500)
        )
        relaunched.start()
        runCurrent()
        assertEquals(taken, relaunched.state.value.outbox.size)
        relaunched.stopFollowing()
    }

    @Test
    fun aMessageUnsentForADayComesBackAsCouldntSendAndABadRecordCostsOnlyItself() = runTest {
        val root = tempFolder.newFolder()
        var clock = started
        val transport = FakeTransport(runningSession)
        val controller = AidenBotSessionController(
            runningSession.botId, transport, backgroundScope, sessionKey = chatKey, store = store(root, { clock }), nowMs = { clock }
        )
        assertTrue(controller.send("Plan lunch"))
        assertTrue(controller.send("And dinner"))
        runCurrent()
        controller.stopFollowing()
        // Corrupt the second record on disk.
        val file = root.walkTopDown().single { it.isFile }
        file.writeText(file.readText().replace("\"text\":\"And dinner\"", "\"text\":7"))

        clock += AidenBotSessionStore.LIFETIME_MS
        val later = AidenBotSessionController(
            runningSession.botId, transport, backgroundScope, sessionKey = chatKey, store = store(root, { clock }), nowMs = { clock }
        )
        later.refetch()
        runCurrent()
        val restored = later.state.value.outgoing
        assertEquals(listOf("Plan lunch"), restored.map { it.text })
        assertEquals(AidenBotOutgoingLook.Failed, later.state.value.look(restored.single()))
        // The bad record is never dropped silently: the file as it was is kept beside the chat's, and the chat says so.
        assertEquals(AidenBotSessionNotice.OUTBOX_UNRESTORABLE, later.state.value.notice)
        val aside = root.walkTopDown().single { it.name.endsWith(".unreadable") }
        assertTrue(aside.readText().contains("\"text\":7"))
        assertTrue("an expired message never goes out late", transport.sends.isEmpty())

        // In memory too: a message deferred for a day says so on the next try.
        val inMemory = AidenBotSessionController(runningSession.botId, transport, backgroundScope, nowMs = { clock })
        assertTrue(inMemory.send("Breakfast"))
        clock += AidenBotSessionStore.LIFETIME_MS
        inMemory.refetch()
        runCurrent()
        assertEquals(AidenBotOutgoingStatus.FAILED, inMemory.state.value.outbox.single().status)
        assertTrue(transport.sends.isEmpty())
    }

    @Test
    fun losingAccessOnTheStreamPurgesTheOutboxEverywhereAndSaysSo() = runTest {
        for (status in listOf(401, 403)) {
            val root = tempFolder.newFolder()
            val sessions = store(root, { started })
            val transport = FakeTransport(runningSession)
            transport.feeds += flow { throw serverError(status, AidenRemoteErrorCode.AUTHENTICATION_REQUIRED) }
            val controller = AidenBotSessionController(
                runningSession.botId, transport, backgroundScope, sessionKey = chatKey, store = sessions, nowMs = { started }
            )
            assertTrue(controller.send("Plan lunch"))
            runCurrent()
            assertTrue(root.walkTopDown().any { it.isFile })
            controller.start()
            runCurrent()
            assertTrue("$status", controller.state.value.outbox.isEmpty())
            assertEquals(AidenBotSessionNotice.ACCESS_LOST, controller.state.value.notice)
            assertTrue("nothing unsent stays on disk after $status", root.walkTopDown().none { it.isFile })
            assertNull(sessions.transcript(chatKey))
        }
    }

    // PR #479 review: a disk restore whose result lands after an access-loss purge must not bring the purged text back.
    @Test
    fun aRestoreThatLandsAfterAnAccessLossPurgeBringsBackNothingUnsent() = runTest {
        val root = tempFolder.newFolder()
        val offline = object : AidenBotSessionTransport by FakeTransport(runningSession) {
            override suspend fun session(botId: String): AidenBotSession = throw IOException("offline")
        }
        val before = AidenBotSessionController(
            runningSession.botId, offline, backgroundScope, sessionKey = chatKey, store = store(root, { started }), nowMs = { started }
        )
        assertTrue(before.send("Plan lunch"))
        runCurrent()
        before.stopFollowing()
        assertTrue("the unsent message is on disk", root.walkTopDown().any { it.isFile })

        // A fresh controller and store: the disk read waits on [io], and the session read on [reply].
        val io = ArrayDeque<Runnable>()
        val fresh = AidenBotSessionStore(root, io = { io.addLast(it) }, nowMs = { started })
        val reply = CompletableDeferred<AidenBotSession>()
        val gated = object : AidenBotSessionTransport by FakeTransport(runningSession) {
            override suspend fun session(botId: String): AidenBotSession = reply.await()
        }
        val controller = AidenBotSessionController(
            runningSession.botId, gated, backgroundScope, sessionKey = chatKey, store = fresh, nowMs = { started }
        )
        backgroundScope.launch { controller.refetch() }
        runCurrent()
        assertEquals("the restore is queued behind the disk", 1, io.size)

        // The Mac answers 403, so its purge is queued on the main thread first. Then the disk read
        // finishes, and its result queues behind that purge.
        reply.completeExceptionally(serverError(403, AidenRemoteErrorCode.AUTHENTICATION_REQUIRED))
        while (io.isNotEmpty()) io.removeFirst().run()
        runCurrent()
        while (io.isNotEmpty()) io.removeFirst().run()
        runCurrent()

        assertTrue(controller.state.value.accessLost)
        assertTrue("nothing unsent is shown", controller.state.value.outgoing.isEmpty())
        assertTrue("nothing unsent is kept on disk", root.walkTopDown().none { it.isFile })
    }

    // PR #479 review: a purge leaves the chat read and empty, so a restore queued before it reads and writes nothing.
    @Test
    fun aRestoreQueuedBeforeAStorePurgeReadsNothingBackAndLeavesNoFile() = runTest {
        val root = tempFolder.newFolder()
        val owner = Any()
        val seeded = store(root, { started })
        seeded.adoptOutbox(chatKey, owner)
        seeded.restoreOutbox(chatKey, owner)
        seeded.storeOutbox(chatKey, owner, listOf(AidenBotOutgoingMessage.create("Plan lunch", null, false, null, started)))
        assertTrue(root.walkTopDown().any { it.isFile })

        val io = ArrayDeque<Runnable>()
        val later = AidenBotSessionStore(root, io = { io.addLast(it) }, nowMs = { started })
        later.adoptOutbox(chatKey, owner)
        val restore = async { later.restoreOutbox(chatKey, owner) }
        runCurrent()
        later.purge(chatKey)
        while (io.isNotEmpty()) io.removeFirst().run()
        runCurrent()

        assertTrue(restore.await().messages.isEmpty())
        assertTrue("no file survives the purge", root.walkTopDown().none { it.isFile })
    }

    @Test
    fun aBotWhoseAccessChangedAndAnUnpairedMacKeepNothingUnsent() = runTest {
        val root = tempFolder.newFolder()
        val sessions = store(root, { started })
        val transport = FakeTransport(runningSession)
        val controller = AidenBotSessionController(
            runningSession.botId, transport, backgroundScope, sessionKey = chatKey, store = sessions, nowMs = { started }
        )
        controller.refetch()
        runCurrent()
        transport.sendFailures += IOException("dropped")
        assertTrue(controller.send("Plan lunch"))
        controller.frame(
            AidenBotSessionEventPayload.State(
                AidenBotSessionStateView(AidenBotSessionState.INTERRUPTED, true, AidenBotSessionBlock.ACCESS_CHANGED)
            )
        )
        assertTrue(controller.state.value.outbox.isEmpty())
        assertEquals(AidenBotSessionNotice.ACCESS_LOST, controller.state.value.notice)

        // Unpair: every chat of the Mac goes, and an open chat can't write it back.
        val other = AidenBotSessionController(
            "bot_fixture_02", transport, backgroundScope, sessionKey = chatKey.copy(botId = "bot_fixture_02"), store = sessions
        )
        assertTrue(other.send("Hello"))
        runCurrent()
        assertTrue(root.walkTopDown().any { it.isFile })
        sessions.purgeInstance(chatKey.instanceId)
        assertTrue(root.walkTopDown().none { it.isFile })
        assertTrue(other.send("Still there?"))
        assertTrue(root.walkTopDown().none { it.isFile })
    }

    @Test
    fun aChatOpensOnItsCachedTranscriptAndShowsSkeletonsOnlyWithNothingToShow() = runTest {
        val sessions = AidenBotSessionStore(null, io = { it.run() })
        val transport = FakeTransport(runningSession)
        val fresh = AidenBotSessionController(runningSession.botId, transport, backgroundScope, sessionKey = chatKey, store = sessions)
        assertTrue(fresh.state.value.showsSkeleton)
        fresh.refetch()
        assertFalse(fresh.state.value.showsSkeleton)
        fresh.frame(AidenBotSessionEventPayload.Entry(userEntry("entry_44", "Thanks")))
        fresh.stopFollowing()

        val reopened = AidenBotSessionController(runningSession.botId, transport, backgroundScope, sessionKey = chatKey, store = sessions)
        assertEquals(listOf("entry_30", "entry_44"), reopened.state.value.entries.map { it.id })
        assertFalse(reopened.state.value.showsSkeleton)
        assertTrue("still connecting, but never blocking", reopened.state.value.isConnecting)
        val otherPairing = AidenBotSessionController(
            runningSession.botId, transport, backgroundScope, sessionKey = chatKey.copy(deviceId = "device_fixture_02"), store = sessions
        )
        assertTrue(otherPairing.state.value.showsSkeleton)
    }

    // --- Task 10: what the chat draws while the Mac isn't reachable (R14) ---

    @Test
    fun aChatSaysConnectingThenOffersTryAgainWithStillSkeletonsWhenItsFirstReadFails() = runTest {
        val transport = FakeTransport(runningSession)
        transport.sessionFailures += IOException("Mac asleep")
        transport.feeds += flow { awaitCancellation() }
        val controller = AidenBotSessionController(runningSession.botId, transport, backgroundScope, activitySupported = true)
        assertEquals(AidenBotConnectionHint.CONNECTING, aidenBotConnectionHint(controller.state.value, started))
        assertEquals(AidenBotSkeletonLook.SHIMMERING, aidenBotSkeletonLook(controller.state.value))

        controller.start()
        runCurrent()
        // Never an endless shimmer: the read failed, so the skeletons rest and Try again shows.
        assertEquals(AidenBotConnectionHint.UNREACHABLE, aidenBotConnectionHint(controller.state.value, started))
        assertEquals(AidenBotSkeletonLook.STILL, aidenBotSkeletonLook(controller.state.value))
        assertTrue("the composer still takes a message", controller.state.value.canSend)

        // Try again reads the session: the hint and skeletons give way to the chat.
        assertTrue(controller.refetch())
        assertNull(aidenBotConnectionHint(controller.state.value, started))
        assertEquals(AidenBotSkeletonLook.HIDDEN, aidenBotSkeletonLook(controller.state.value))
        controller.stopFollowing()
    }

    @Test
    fun aCachedChatShowsItsTranscriptNotSkeletonsAndAMissingBotShowsNeitherHintNorSkeletons() = runTest {
        val sessions = AidenBotSessionStore(null, io = { it.run() })
        val transport = FakeTransport(runningSession)
        val first = AidenBotSessionController(runningSession.botId, transport, backgroundScope, sessionKey = chatKey, store = sessions)
        first.refetch()
        first.stopFollowing()

        transport.sessionFailures += IOException("Mac asleep")
        val reopened = AidenBotSessionController(runningSession.botId, transport, backgroundScope, sessionKey = chatKey, store = sessions)
        reopened.refetch()
        assertEquals(AidenBotSkeletonLook.HIDDEN, aidenBotSkeletonLook(reopened.state.value))
        assertFalse(reopened.state.value.entries.isEmpty())

        val gone = FakeTransport(runningSession)
        gone.sessionFailures += serverError(404)
        val missing = AidenBotSessionController(runningSession.botId, gone, backgroundScope)
        missing.refetch()
        assertTrue(missing.state.value.botMissing)
        assertNull(aidenBotConnectionHint(missing.state.value, started))
        assertEquals(AidenBotSkeletonLook.HIDDEN, aidenBotSkeletonLook(missing.state.value))
    }

    @Test
    fun aDroppedFeedSaysReconnectingOnTheLineAloneAndConnectingWhenIdle() = runTest {
        val dropped = flow<AidenBotSessionEvent> { throw IOException("Wi-Fi dropped") }
        val working = FakeTransport(activitySession)
        working.feeds += flow {
            emit(snapshotOf(activitySession))
            throw IOException("Wi-Fi dropped")
        }
        working.feeds += flow { awaitCancellation() }
        val running = AidenBotSessionController(activitySession.botId, working, backgroundScope, activitySupported = true)
        running.start()
        runCurrent()
        assertEquals(AidenBotActivityPhase.RECONNECTING, aidenBotStatusLine(running.state.value, started)!!.display.phase)
        assertNull("the line already says it", aidenBotConnectionHint(running.state.value, started))
        running.stopFollowing()

        val idleSession = activitySession.copy(state = AidenBotSessionState.IDLE, activity = null)
        val quiet = FakeTransport(idleSession)
        quiet.feeds += flow {
            emit(snapshotOf(idleSession))
            throw IOException("Wi-Fi dropped")
        }
        quiet.feeds += dropped
        val idle = AidenBotSessionController(idleSession.botId, quiet, backgroundScope, activitySupported = true)
        idle.start()
        runCurrent()
        assertNull(aidenBotStatusLine(idle.state.value, started))
        assertEquals(AidenBotConnectionHint.CONNECTING, aidenBotConnectionHint(idle.state.value, started))
        idle.stopFollowing()
    }

    @Test
    fun aCleanCloseDoesNotFlashReconnecting() = runTest {
        val transport = FakeTransport(runningSession)
        transport.feeds += flow {
            emit(snapshotOf(runningSession))
            emit(AidenBotSessionEvent(runningSession.botId, runningSession.epoch, runningSession.seq + 1, AidenBotSessionEventPayload.Closed))
        }
        transport.feeds += flow {
            delay(300)
            emit(snapshotOf(runningSession))
            awaitCancellation()
        }
        val controller = AidenBotSessionController(
            runningSession.botId, transport, backgroundScope, activitySupported = true, reconnectDelayMillis = 200
        )
        controller.start()
        runCurrent()
        assertFalse(controller.state.value.streamDown)
        advanceTimeBy(600)
        runCurrent()
        assertFalse("the reconnect came back before it would show", controller.state.value.streamDown)
        controller.stopFollowing()

        // A close whose reconnect never answers does say so, after the debounce.
        val stuck = FakeTransport(runningSession)
        stuck.feeds += flow { emit(snapshotOf(runningSession)) }
        stuck.feeds += flow { awaitCancellation() }
        val waiting = AidenBotSessionController(
            runningSession.botId, stuck, backgroundScope, activitySupported = true, reconnectDelayMillis = 200
        )
        waiting.start()
        runCurrent()
        assertFalse(waiting.state.value.streamDown)
        advanceTimeBy(2_500)
        runCurrent()
        assertTrue(waiting.state.value.streamDown)
        waiting.stopFollowing()
    }

    // --- R18: every turn control applies at once ---

    @Test
    fun stopSaysStoppingAtOnceRevertsOnFailureAndANewRunClearsIt() = runTest {
        val transport = FakeTransport(runningSession)
        val controller = AidenBotSessionController(runningSession.botId, transport, backgroundScope, activitySupported = true)
        controller.refetch()
        transport.stopGate = CompletableDeferred()
        transport.stopFailures += IOException("offline")
        val stopping = async { controller.stop() }
        runCurrent()
        assertTrue(controller.state.value.isStopping)
        assertEquals(AidenBotActivityPhase.STOPPING, aidenBotStatusLine(controller.state.value, started)!!.display.phase)
        assertFalse("a second tap sends nothing", controller.stop())
        transport.stopGate!!.complete(Unit)
        assertFalse(stopping.await())
        assertFalse(controller.state.value.isStopping)
        assertEquals(AidenBotActivityPhase.APP, aidenBotStatusLine(controller.state.value, started)!!.display.phase)

        // Stop reaches the Mac, but a queued follow-up starts a new run before the Mac's word.
        transport.stopState = AidenBotSessionState.RUNNING
        transport.stopGate = CompletableDeferred()
        val again = async { controller.stop() }
        runCurrent()
        controller.frame(AidenBotSessionEventPayload.Activity(AidenBotSessionActivity("thinking", null, started + 5_000)))
        assertFalse("the new run has nothing to stop", controller.state.value.isStopping)
        transport.stopGate!!.complete(Unit)
        assertTrue(again.await())
        assertFalse(controller.state.value.isStopping)
        assertEquals(AidenBotActivityPhase.THINKING, aidenBotStatusLine(controller.state.value, started)!!.display.phase)
    }

    @Test
    fun stopPressedWithNothingRunningNeverMakesTheNextTurnSayStopping() = runTest {
        val idle = runningSession.copy(state = AidenBotSessionState.IDLE, activity = null, question = colourQuestion)
        val transport = FakeTransport(idle)
        val controller = AidenBotSessionController(idle.botId, transport, backgroundScope, activitySupported = true)
        controller.refetch()
        assertTrue(controller.stop())
        controller.frame(AidenBotSessionEventPayload.State(AidenBotSessionStateView(AidenBotSessionState.RUNNING, false)))
        assertFalse(controller.state.value.isStopping)
        assertEquals(AidenBotActivityPhase.PREPARING, aidenBotStatusLine(controller.state.value, started)!!.display.phase)
    }

    @Test
    fun resumeAndDismissApplyAtOnceAndRollBackOnlyWhatNothingNewerReplaced() = runTest {
        val transport = FakeTransport(interruptedSession)
        val controller = AidenBotSessionController(interruptedSession.botId, transport, backgroundScope, activitySupported = true)
        controller.refetch()

        // Resume: "Picking up where it left off" at once; an unrelated frame, then a failure, rolls back.
        transport.resumeGate = CompletableDeferred()
        transport.failNextResume = true
        val resuming = async { controller.resume() }
        runCurrent()
        assertFalse(controller.state.value.isInterrupted)
        assertEquals(AidenBotActivityPhase.RESUMING, aidenBotStatusLine(controller.state.value, started)!!.display.phase)
        controller.frame(AidenBotSessionEventPayload.Partial("Your first meeting is at 9:30"))
        transport.resumeGate!!.complete(Unit)
        assertFalse(resuming.await())
        assertTrue(controller.state.value.isInterrupted)
        assertEquals("Aiden couldn’t reach your Mac. Try again.", controller.state.value.actionError)

        // Dismiss: gone at once; the Mac's own state frame in between wins over the rollback.
        transport.dismissGate = CompletableDeferred()
        transport.dismissFailures += IOException("offline")
        val dismissing = async { controller.dismiss() }
        runCurrent()
        assertFalse(controller.state.value.isInterrupted)
        controller.frame(AidenBotSessionEventPayload.State(AidenBotSessionStateView(AidenBotSessionState.RUNNING, false)))
        transport.dismissGate!!.complete(Unit)
        assertFalse(dismissing.await())
        assertEquals(AidenBotSessionState.RUNNING, controller.state.value.state)

        // An unrelated frame alone still lets a failed Dismiss come back.
        transport.session = interruptedSession.copy(seq = 40)
        controller.refetch()
        transport.dismissGate = CompletableDeferred()
        transport.dismissFailures += IOException("offline")
        val second = async { controller.dismiss() }
        runCurrent()
        controller.frame(AidenBotSessionEventPayload.Partial("x"))
        transport.dismissGate!!.complete(Unit)
        assertFalse(second.await())
        assertTrue(controller.state.value.isInterrupted)
    }

    @Test
    fun anAnswerAndAnApprovalHideAtOnceAndComeBackOnlyIfNothingNewerReplacedThem() = runTest {
        val transport = FakeTransport(sessionEndingWith().copy(question = colourQuestion))
        val controller = AidenBotSessionController(transport.session.botId, transport, backgroundScope)
        controller.refetch()
        val answer = AidenQuestionRespondRequest(false, listOf(AidenQuestionAnswer.Option(0, "Blue")))
        transport.answerGate = CompletableDeferred()
        transport.failNextAnswer = true
        val answering = async { controller.answerQuestion(answer) }
        runCurrent()
        assertNull(controller.state.value.session?.question)
        controller.frame(AidenBotSessionEventPayload.Partial("x"))
        transport.answerGate!!.complete(Unit)
        assertFalse(answering.await())
        assertEquals(colourQuestion, controller.state.value.session?.question)

        // The Mac moved on to another question meanwhile: the old one stays gone.
        transport.answerGate = CompletableDeferred()
        transport.failNextAnswer = true
        val again = async { controller.answerQuestion(answer) }
        runCurrent()
        val next = colourQuestion.copy(waitId = "6f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c")
        controller.frame(AidenBotSessionEventPayload.Question(next))
        transport.answerGate!!.complete(Unit)
        assertFalse(again.await())
        assertEquals(next, controller.state.value.session?.question)

        // Approvals: hidden at once, back after an unrelated frame and a failure.
        val (approvals, approvalController) = approvalController(mailApproval, backgroundScope)
        approvalController.refetch()
        approvals.approvalGate = CompletableDeferred()
        approvals.approvalFailures += IOException("offline")
        val deciding = async { approvalController.respondToApproval(AidenApprovalDecision.DENY) }
        runCurrent()
        assertNull(approvalController.state.value.session?.approval)
        approvalController.frame(AidenBotSessionEventPayload.Partial("x"))
        approvals.approvalGate!!.complete(Unit)
        assertFalse(deciding.await())
        assertEquals(mailApproval, approvalController.state.value.session?.approval)
        assertEquals("Aiden couldn’t send that. Try again.", approvalController.state.value.actionError)
    }

    @Test
    fun aProposalAnswerSettlesAtOnceAndGoesBackToPendingOnFailure() = runTest {
        val transport = FakeTransport(cardsSession)
        val controller = AidenBotSessionController(cardsSession.botId, transport, backgroundScope)
        controller.refetch()
        transport.proposalGate = CompletableDeferred()
        transport.proposalFailures += IOException("offline")
        val answering = async { controller.respondToProposal(pendingProposalId, AidenBotRoutineProposalDecision.ACCEPT) }
        runCurrent()
        assertEquals(AidenBotRoutineProposalStatus.ACCEPTED, controller.state.value.proposal(pendingProposalId).status)
        controller.frame(AidenBotSessionEventPayload.Partial("x"))
        transport.proposalGate!!.complete(Unit)
        assertFalse(answering.await())
        assertEquals(AidenBotRoutineProposalStatus.PENDING, controller.state.value.proposal(pendingProposalId).status)
        assertEquals(AidenBotProposalPhase.FAILED, controller.state.value.proposalResponses[pendingProposalId])
    }

    // Task 8 review: an optimistic Stop or Resume never leaves the line on the run before's phase.
    @Test
    fun theLineNeverShowsAStalePhaseAfterResumeStopOrANewTurn() = runTest {
        val paused = interruptedSession.copy(partial = null, activity = AidenBotSessionActivity("app", "Notion", started))
        val transport = FakeTransport(paused)
        val controller = AidenBotSessionController(paused.botId, transport, backgroundScope, activitySupported = true)
        controller.refetch()
        assertTrue(controller.resume())
        assertEquals(
            "the Mac took the Resume: its intent, not the paused run's app",
            AidenBotActivityPhase.RESUMING,
            aidenBotStatusLine(controller.state.value, started)!!.display.phase
        )
        controller.frame(AidenBotSessionEventPayload.Activity(AidenBotSessionActivity("searching", null, started + 9_000)))
        assertEquals(AidenBotActivityPhase.SEARCHING, aidenBotStatusLine(controller.state.value, started)!!.display.phase)

        // Stopped: the next turn starts at "Getting ready", not at the stopped run's phase.
        assertTrue(controller.stop())
        assertNull(aidenBotStatusLine(controller.state.value, started))
        controller.frame(AidenBotSessionEventPayload.State(AidenBotSessionStateView(AidenBotSessionState.RUNNING, false)))
        assertEquals(AidenBotActivityPhase.PREPARING, aidenBotStatusLine(controller.state.value, started)!!.display.phase)
    }

    // Fix round 1: a frozen request goes out exactly as frozen.
    @Test
    fun aFrozenSteerKeepsItsModeWhenTheMacsAnnouncementChanges() = runTest {
        val transport = FakeTransport(runningSession)
        val controller = AidenBotSessionController(runningSession.botId, transport, backgroundScope, activitySupported = true)
        controller.refetch()
        transport.sendFailures += IOException("dropped")
        assertTrue(controller.send("Keep it vegetarian.", AidenStreamInputMode.STEER))
        controller.setActivitySupported(false)
        advanceTimeBy(1_001)
        runCurrent()
        assertEquals(listOf(AidenStreamInputMode.STEER, AidenStreamInputMode.STEER), transport.sendModes)
        assertEquals("one request under one key", 1, transport.sends.map { it.second }.toSet().size)
    }

    // Fix round 1: an entry naming another submission never makes an exhausted message vanish.
    @Test
    fun anExhaustedMessageWhoseLookAlikeEntryIsAnothersFailsVisibly() = runTest {
        val transport = FakeTransport(runningSession)
        val controller = AidenBotSessionController(runningSession.botId, transport, backgroundScope, activitySupported = true)
        controller.refetch()
        transport.sendFailures += listOf(IOException("one"), IOException("two"), IOException("three"))
        assertTrue(controller.send("Yes."))
        // Another device's "Yes." lands while this one waits for its retry.
        controller.frame(AidenBotSessionEventPayload.Entry(userEntry("entry_45", "Yes.", "99")))
        assertTrue("an unsettled request may wait on it", controller.state.value.outgoing.isEmpty())
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(3, transport.sends.size)
        val failed = controller.state.value.outgoing.single()
        assertEquals(AidenBotOutgoingLook.Failed, controller.state.value.look(failed))
        controller.frame(AidenBotSessionEventPayload.Partial("Sure"))
        assertEquals("still there after the next frame", listOf(failed.id), controller.state.value.outgoing.map { it.id })
        assertTrue(controller.retrySend(failed.id))
        assertEquals("Try again replays the key", transport.sends[0].second, transport.sends[3].second)
    }

    @Test
    fun anActivityFrameAfterAResumeTapSaysWhatTheRunIsDoing() = runTest {
        val transport = FakeTransport(interruptedSession.copy(partial = null))
        val controller = AidenBotSessionController(interruptedSession.botId, transport, backgroundScope, activitySupported = true)
        controller.refetch()
        transport.resumeGate = CompletableDeferred()
        val resuming = async { controller.resume() }
        runCurrent()
        assertEquals(AidenBotActivityPhase.RESUMING, aidenBotStatusLine(controller.state.value, started)!!.display.phase)
        // A cleared activity says nothing about the resumed run: it still picks up.
        controller.frame(AidenBotSessionEventPayload.Activity(null))
        assertEquals(AidenBotActivityPhase.RESUMING, aidenBotStatusLine(controller.state.value, started)!!.display.phase)
        controller.frame(AidenBotSessionEventPayload.Activity(AidenBotSessionActivity("reading", null, started)))
        assertEquals(AidenBotActivityPhase.READING, aidenBotStatusLine(controller.state.value, started)!!.display.phase)
        transport.resumeGate!!.complete(Unit)
        assertTrue(resuming.await())
        assertEquals(AidenBotActivityPhase.READING, aidenBotStatusLine(controller.state.value, started)!!.display.phase)
    }

    // Fix round 1: the disk is read on the io thread, and nothing goes out before it.
    @Test
    fun aSlowDiskReadHoldsBackNewMessagesUntilTheOlderOnesAreBack() = runTest {
        val root = tempFolder.newFolder()
        val transport = FakeTransport(runningSession)
        val offline = object : AidenBotSessionTransport by transport {
            override suspend fun session(botId: String): AidenBotSession = throw IOException("offline")
        }
        val before = AidenBotSessionController(runningSession.botId, offline, backgroundScope, sessionKey = chatKey, store = store(root, { started }))
        assertTrue(before.send("Plan lunch"))
        runCurrent()
        before.stopFollowing()

        val io = ArrayDeque<Runnable>()
        val slow = AidenBotSessionStore(root, io = { io.addLast(it) }, nowMs = { started })
        val relaunched = AidenBotSessionController(runningSession.botId, transport, backgroundScope, sessionKey = chatKey, store = slow)
        assertTrue(relaunched.send("And dinner"))
        relaunched.refetch()
        runCurrent()
        assertTrue("connected, but the older message isn't back yet", transport.sends.isEmpty())
        while (io.isNotEmpty()) io.removeFirst().run()
        runCurrent()
        while (io.isNotEmpty()) io.removeFirst().run()
        assertEquals(listOf("Plan lunch", "And dinner"), transport.sends.map { it.first })
    }

    // --- Final fix wave ---

    // FR-I2: a file this build can't read is set aside, never deleted, and the chat says so.
    @Test
    fun anOutboxFileThatCantBeReadIsSetAsideAndTheChatSaysSo() = runTest {
        val maxBytes = 1_500
        val damages: List<Pair<String, (java.io.File) -> Unit>> = listOf(
            "garbage" to { file -> file.writeText("not an outbox") },
            "a newer version" to { file -> file.writeText(file.readText().replace("\"version\":1", "\"version\":2")) },
            "oversized" to { file -> file.writeText(" ".repeat(2 * maxBytes + 1)) },
            "unopenable" to { file -> assertTrue(file.setReadable(false)) }
        )
        for ((name, damage) in damages) {
            val root = tempFolder.newFolder()
            val transport = FakeTransport(runningSession)
            val writer = AidenBotSessionController(
                runningSession.botId, transport, backgroundScope, sessionKey = chatKey, store = store(root, { started }, maxBytes), nowMs = { started }
            )
            assertTrue(writer.send("Plan my week."))
            runCurrent()
            writer.stopFollowing()
            val file = root.walkTopDown().single { it.isFile }
            damage(file)
            val damagedSize = file.length()
            try {
                val reader = AidenBotSessionController(
                    runningSession.botId, transport, backgroundScope, sessionKey = chatKey, store = store(root, { started }, maxBytes), nowMs = { started }
                )
                reader.start()
                runCurrent()
                assertEquals(name, AidenBotSessionNotice.OUTBOX_UNRESTORABLE, reader.state.value.notice)
                assertTrue(name, reader.state.value.outgoing.isEmpty())
                val aside = root.walkTopDown().filter { it.name.endsWith(".unreadable") }.toList()
                assertEquals("$name: set aside, never deleted", 1, aside.size)
                assertEquals("$name: kept as it was", damagedSize, aside.single().length())

                // The chat writes its own outbox afresh beside it.
                assertTrue(reader.send("Again"))
                runCurrent()
                assertTrue(name, file.exists())
                assertEquals(name, 1, root.walkTopDown().count { it.name.endsWith(".unreadable") })
                reader.stopFollowing()
            } finally {
                root.walkTopDown().forEach { it.setReadable(true) }
            }
        }
    }

    // Controller polish: a restore that can't run still ends, so the chat sends and says so.
    @Test
    fun aRestoreThatCantRunStillLetsTheChatSendAndSaysSo() = runTest {
        val root = tempFolder.newFolder()
        val transport = FakeTransport(runningSession)
        val broken = AidenBotSessionStore(root, io = { throw java.util.concurrent.RejectedExecutionException("shut down") }, nowMs = { started })
        val controller = AidenBotSessionController(runningSession.botId, transport, backgroundScope, sessionKey = chatKey, store = broken, nowMs = { started })
        assertTrue(controller.send("Plan lunch"))
        controller.refetch()
        runCurrent()
        assertEquals(listOf("Plan lunch"), transport.sends.map { it.first })
        assertEquals(AidenBotSessionNotice.OUTBOX_UNRESTORABLE, controller.state.value.notice)
    }

    // Controller polish: a restore that runs past the limit drops nothing; the newest say "Couldn't send".
    @Test
    fun aRestoreThatRunsPastTheLimitKeepsEveryMessageAndFailsTheNewest() = runTest {
        val root = tempFolder.newFolder()
        val offline = object : AidenBotSessionTransport by FakeTransport(runningSession) {
            override suspend fun session(botId: String): AidenBotSession = throw IOException("offline")
        }
        val before = AidenBotSessionController(runningSession.botId, offline, backgroundScope, sessionKey = chatKey, store = store(root, { started }), nowMs = { started })
        repeat(15) { assertTrue(before.send("Earlier $it")) }
        runCurrent()
        before.stopFollowing()

        val io = ArrayDeque<Runnable>()
        val slow = AidenBotSessionStore(root, io = { io.addLast(it) }, nowMs = { started })
        val transport = FakeTransport(runningSession)
        val relaunched = AidenBotSessionController(runningSession.botId, transport, backgroundScope, sessionKey = chatKey, store = slow, nowMs = { started })
        repeat(10) { assertTrue("the disk isn't read yet", relaunched.send("Later $it")) }
        relaunched.start()
        runCurrent()
        while (io.isNotEmpty()) io.removeFirst().run()
        runCurrent()
        val outbox = relaunched.state.value.outbox
        assertEquals("nothing dropped", 25, outbox.size)
        assertEquals(List(15) { "Earlier $it" } + List(10) { "Later $it" }, outbox.map { it.text })
        assertEquals(
            List(5) { "Later ${5 + it}" },
            outbox.filter { it.status == AidenBotOutgoingStatus.FAILED }.map { it.text }
        )
        assertEquals(AidenBotSessionNotice.OUTBOX_FULL, relaunched.state.value.notice)
        // Past the limit, Try again waits until some are sent or removed.
        assertFalse(relaunched.retrySend(outbox.last().id))
        relaunched.stopFollowing()
        while (io.isNotEmpty()) io.removeFirst().run()

        // A later launch reads every one of them back: the newest are never cut off.
        val again = AidenBotSessionController(runningSession.botId, offline, backgroundScope, sessionKey = chatKey, store = store(root, { started }), nowMs = { started })
        again.start()
        runCurrent()
        assertEquals(25, again.state.value.outbox.size)
        again.stopFollowing()
    }

    // Controller polish: a controller whose store refused its frozen request sends nothing.
    @Test
    fun aControllerThatLosesTheChatBeforeItsFirstAttemptSendsNothing() = runTest {
        val sessions = AidenBotSessionStore(null, io = { it.run() })
        val transport = FakeTransport(runningSession)
        val older = AidenBotSessionController(runningSession.botId, transport, backgroundScope, sessionKey = chatKey, store = sessions)
        assertTrue("waits for the connection", older.send("From the old screen"))
        runCurrent()
        // Another screen takes the chat after this one's outbox was read.
        AidenBotSessionController(runningSession.botId, transport, backgroundScope, sessionKey = chatKey, store = sessions)
        older.refetch()
        runCurrent()
        assertTrue(transport.sends.isEmpty())
    }

    // A transport that records every key and, while [hung], never answers.
    private class HangingTransport(private val delegate: FakeTransport) : AidenBotSessionTransport by delegate {
        var hung = false
        val keys = mutableMapOf<String, MutableList<UUID>>()
        private suspend fun <T> call(action: String, key: UUID?, answer: suspend () -> T): T {
            if (key != null) keys.getOrPut(action) { mutableListOf() } += key
            if (hung) awaitCancellation()
            return answer()
        }
        override suspend fun session(botId: String) = call("session", null) { delegate.session(botId) }
        override suspend fun send(botId: String, text: String, key: UUID, whenBusy: AidenStreamInputMode?) =
            call("send", key) { delegate.send(botId, text, key, whenBusy) }
        override suspend fun resume(botId: String, key: UUID) = call("resume", key) { delegate.resume(botId, key) }
        override suspend fun dismiss(botId: String, key: UUID) = call("dismiss", key) { delegate.dismiss(botId, key) }
        override suspend fun stop(botId: String, key: UUID) = call("stop", key) { delegate.stop(botId, key) }
        override suspend fun answerQuestion(botId: String, waitId: String, request: AidenQuestionRespondRequest, key: UUID) =
            call("answer", key) { delegate.answerQuestion(botId, waitId, request, key) }
        override suspend fun respondToApproval(waitId: String, decision: AidenApprovalDecision, key: UUID) =
            call("approval", key) { delegate.respondToApproval(waitId, decision, key) }
        override suspend fun respondToRoutineProposal(botId: String, proposalId: String, decision: AidenBotRoutineProposalDecision, key: UUID) =
            call("proposal", key) { delegate.respondToRoutineProposal(botId, proposalId, decision, key) }
    }

    /** Runs [action] against a Mac that never answers: it gives up at the limit, and returns false. */
    private suspend fun kotlinx.coroutines.test.TestScope.givesUpInTime(action: suspend () -> Boolean) {
        val call = async { action() }
        advanceTimeBy(AidenBotSessionController.REQUEST_LIMIT_MILLIS - 1)
        runCurrent()
        assertFalse("still waiting just before the limit", call.isCompleted)
        advanceTimeBy(2)
        runCurrent()
        assertTrue(call.isCompleted)
        assertFalse(call.await())
    }

    // FR-I3: every Bot session request is bounded, and a timeout keeps the key (it may have arrived).
    @Test
    fun aMacThatNeverAnswersTimesOutEveryRequestAndTheKeyIsKept() = runTest {
        // The session read.
        val reading = HangingTransport(FakeTransport(runningSession)).apply { hung = true }
        val reader = AidenBotSessionController(runningSession.botId, reading, backgroundScope)
        givesUpInTime { reader.refetch() }
        assertTrue(reader.state.value.loadFailed)

        // A message: it waits for the next try under its key, and goes out under it.
        val sending = HangingTransport(FakeTransport(runningSession))
        val sender = AidenBotSessionController(runningSession.botId, sending, backgroundScope)
        sender.refetch()
        sending.hung = true
        val sent = async { sender.send("Plan lunch") }
        advanceTimeBy(AidenBotSessionController.REQUEST_LIMIT_MILLIS + 1)
        runCurrent()
        assertTrue(sent.await())
        assertTrue(sender.state.value.outbox.single().keepsKey)
        sending.hung = false
        advanceTimeBy(1_001)
        runCurrent()
        assertEquals(AidenBotOutgoingStatus.SENT, sender.state.value.outbox.single().status)
        assertEquals(1, sending.keys.getValue("send").toSet().size)

        // Stop, Resume and Dismiss: each rolls back, and the next tap replays the key.
        val stopping = HangingTransport(FakeTransport(runningSession))
        val stopper = AidenBotSessionController(runningSession.botId, stopping, backgroundScope, activitySupported = true)
        stopper.refetch()
        stopping.hung = true
        givesUpInTime { stopper.stop() }
        assertFalse(stopper.state.value.isStopping)
        givesUpInTime { stopper.stop() }
        assertEquals(1, stopping.keys.getValue("stop").toSet().size)

        val pausing = HangingTransport(FakeTransport(interruptedSession))
        val paused = AidenBotSessionController(interruptedSession.botId, pausing, backgroundScope)
        paused.refetch()
        pausing.hung = true
        givesUpInTime { paused.resume() }
        assertTrue(paused.state.value.isInterrupted)
        givesUpInTime { paused.dismiss() }
        assertTrue(paused.state.value.isInterrupted)
        givesUpInTime { paused.resume() }
        assertEquals(1, pausing.keys.getValue("resume").toSet().size)

        // A question's answer and an approval's decision come back with their keys kept.
        val waiting = sessionEndingWith().copy(question = colourQuestion, approval = mailApproval)
        val asking = HangingTransport(FakeTransport(waiting))
        val asked = AidenBotSessionController(waiting.botId, asking, backgroundScope)
        asked.refetch()
        asking.hung = true
        val answer = AidenQuestionRespondRequest(false, listOf(AidenQuestionAnswer.Option(0, "Blue")))
        givesUpInTime { asked.answerQuestion(answer) }
        assertEquals(colourQuestion, asked.state.value.session?.question)
        givesUpInTime { asked.answerQuestion(answer) }
        assertEquals(1, asking.keys.getValue("answer").toSet().size)
        givesUpInTime { asked.respondToApproval(AidenApprovalDecision.DENY) }
        assertEquals(mailApproval, asked.state.value.session?.approval)
        givesUpInTime { asked.respondToApproval(AidenApprovalDecision.DENY) }
        assertEquals(1, asking.keys.getValue("approval").toSet().size)

        // A routine proposal goes back to pending.
        val proposing = HangingTransport(FakeTransport(cardsSession))
        val proposer = AidenBotSessionController(cardsSession.botId, proposing, backgroundScope)
        proposer.refetch()
        proposing.hung = true
        givesUpInTime { proposer.respondToProposal(pendingProposalId, AidenBotRoutineProposalDecision.ACCEPT) }
        assertEquals(AidenBotRoutineProposalStatus.PENDING, proposer.state.value.proposal(pendingProposalId).status)
        givesUpInTime { proposer.respondToProposal(pendingProposalId, AidenBotRoutineProposalDecision.ACCEPT) }
        assertEquals(1, proposing.keys.getValue("proposal").toSet().size)
    }

    // FR-m2: the Mac's answer stands unless the Mac wrote the state since the tap.
    @Test
    fun theMacsAnswerAppliesUnlessTheMacWroteTheStateSinceTheTap() = runTest {
        val transport = FakeTransport(runningSession)
        val controller = AidenBotSessionController(runningSession.botId, transport, backgroundScope, activitySupported = true)
        controller.refetch()

        // Stop: an unrelated frame arrives before the answer, which still stands.
        transport.stopGate = CompletableDeferred()
        val stopping = async { controller.stop() }
        runCurrent()
        controller.frame(AidenBotSessionEventPayload.Partial("Here is"))
        transport.stopGate!!.complete(Unit)
        assertTrue(stopping.await())
        assertEquals(AidenBotSessionState.IDLE, controller.state.value.state)

        // A send: the receipt's state stands after an entry frame, not after a state frame.
        transport.receiptState = AidenBotSessionState.RUNNING
        transport.sendGate = CompletableDeferred()
        val sending = async { controller.send("Plan lunch") }
        runCurrent()
        controller.frame(AidenBotSessionEventPayload.Entry(userEntry("entry_60", "Something else")))
        transport.sendGate!!.complete(Unit)
        assertTrue(sending.await())
        assertEquals(AidenBotSessionState.RUNNING, controller.state.value.state)

        transport.stopState = AidenBotSessionState.RUNNING
        transport.stopGate = CompletableDeferred()
        val second = async { controller.stop() }
        runCurrent()
        controller.frame(AidenBotSessionEventPayload.State(AidenBotSessionStateView(AidenBotSessionState.IDLE, false)))
        transport.stopGate!!.complete(Unit)
        assertTrue(second.await())
        assertEquals("the Mac's newer state wins over the older answer", AidenBotSessionState.IDLE, controller.state.value.state)
    }

    // FR-m5: a taken message nothing on the Mac shows is marked unheld and goes only once 10 s have passed.
    @Test
    fun aTakenMessageNothingOnTheMacShowsGoesOnlyAfterItsGrace() = runTest {
        val transport = FakeTransport(runningSession)
        transport.receiptIds += listOf("21", "22")
        val controller = AidenBotSessionController(runningSession.botId, transport, backgroundScope, activitySupported = true)
        controller.refetch()
        var seq = runningSession.seq
        suspend fun snapshot(queued: List<AidenBotQueuedMessage> = emptyList()) {
            seq += 1
            controller.handle(snapshotOf(runningSession.copy(seq = seq, queued = queued)))
        }

        assertTrue(controller.send("Plan lunch"))
        snapshot()
        snapshot()
        assertEquals("a second look within the grace keeps it", listOf("Plan lunch"), controller.state.value.outgoing.map { it.text })
        advanceTimeBy(AidenBotSessionController.UNHELD_GRACE_MILLIS - 1)
        runCurrent()
        assertEquals(listOf("Plan lunch"), controller.state.value.outgoing.map { it.text })
        advanceTimeBy(2)
        runCurrent()
        assertTrue(controller.state.value.outbox.isEmpty())

        // Showing up queued again clears the mark.
        assertTrue(controller.send("And dinner"))
        snapshot()
        snapshot(listOf(AidenBotQueuedMessage("22", AidenStreamInputMode.QUEUE, "And dinner")))
        advanceTimeBy(AidenBotSessionController.UNHELD_GRACE_MILLIS + 1)
        runCurrent()
        assertEquals("22", controller.state.value.outbox.single().queuedId)
        assertFalse(controller.state.value.outbox.single().unheld)
    }

    // Controller polish: a frozen request refused for the Bot's state keeps its key for Try again.
    @Test
    fun aFrozenMessageTheBotCantTakeKeepsItsKey() = runTest {
        val transport = FakeTransport(runningSession)
        val controller = AidenBotSessionController(runningSession.botId, transport, backgroundScope)
        controller.refetch()
        transport.sendFailures += IOException("dropped")
        assertTrue(controller.send("Plan lunch"))
        controller.frame(AidenBotSessionEventPayload.State(AidenBotSessionStateView(AidenBotSessionState.NEEDS_MODEL, false)))
        advanceTimeBy(1_001)
        runCurrent()
        val failed = controller.state.value.outbox.single()
        assertEquals(AidenBotOutgoingStatus.FAILED, failed.status)
        assertTrue("its first attempt may have arrived", failed.keepsKey)
    }

    // FR-m4: the copy shared with iOS.
    @Test
    fun theOutboxNoticesUseTheCopySharedWithIos() {
        val document = javax.xml.parsers.DocumentBuilderFactory.newInstance().newDocumentBuilder()
            .parse(java.io.File("src/main/res/values/strings.xml"))
        val nodes = document.getElementsByTagName("string")
        val strings = (0 until nodes.length).associate { index ->
            val element = nodes.item(index) as org.w3c.dom.Element
            element.getAttribute("name") to element.textContent
        }
        fun english(id: Int) = strings.getValue(sbtbiswas.AidenOnTheGo.R.string::class.java.fields.first { it.getInt(null) == id }.name)
        assertEquals("That message wasn’t sent. Please try again.", english(AidenBotSessionNotice.ACCESS_LOST.text))
        assertEquals("Too many messages are waiting. Send or remove some, then try again.", english(AidenBotSessionNotice.OUTBOX_FULL.text))
        assertEquals("Some unsent messages couldn’t be restored.", english(AidenBotSessionNotice.OUTBOX_UNRESTORABLE.text))
        val r = sbtbiswas.AidenOnTheGo.R.string::class.java
        fun named(name: String) = english(r.getField(name).getInt(null))
        assertEquals(
            "Couldn’t send · Try again",
            "${named("bot_session_send_failed")} ${named("bot_session_send_failed_separator")} ${named("bot_session_try_again")}"
        )
    }

    // Chat polish: a first read the Mac refuses says so, and Try again shows at once that it's trying.
    @Test
    fun aRefusedFirstReadSaysAccessAndTryAgainShowsItIsTrying() = runTest {
        val refused = FakeTransport(runningSession).apply { sessionFailures += serverError(403, AidenRemoteErrorCode.AUTHENTICATION_REQUIRED) }
        val locked = AidenBotSessionController(runningSession.botId, refused, backgroundScope)
        assertFalse(locked.refetch())
        assertEquals(AidenBotConnectionHint.NO_ACCESS, aidenBotConnectionHint(locked.state.value, started))

        val hanging = HangingTransport(FakeTransport(runningSession))
        hanging.hung = true
        val controller = AidenBotSessionController(runningSession.botId, hanging, backgroundScope)
        val first = async { controller.refetch() }
        advanceTimeBy(AidenBotSessionController.REQUEST_LIMIT_MILLIS + 1)
        runCurrent()
        assertFalse(first.await())
        assertEquals(AidenBotConnectionHint.UNREACHABLE, aidenBotConnectionHint(controller.state.value, started))
        assertEquals(AidenBotSkeletonLook.STILL, aidenBotSkeletonLook(controller.state.value))
        val again = async { controller.refetch() }
        runCurrent()
        assertEquals("trying again", AidenBotConnectionHint.CONNECTING, aidenBotConnectionHint(controller.state.value, started))
        assertEquals(AidenBotSkeletonLook.SHIMMERING, aidenBotSkeletonLook(controller.state.value))
        hanging.hung = false
        again.cancel()
    }

    // --- Revision 37 (`bot:handoffs`): hand-off cards and the paused state ---

    private val handoffFixture by lazy { fixture.getValue("botHandoffs").jsonObject }
    private val handoffSession by lazy { json.decodeFromJsonElement(AidenBotSession.serializer(), handoffFixture.getValue("session")) }
    private val pausedSession by lazy { json.decodeFromJsonElement(AidenBotSession.serializer(), handoffFixture.getValue("pausedSession")) }
    private val handoffEvents by lazy {
        json.decodeFromJsonElement(ListSerializer(AidenBotSessionEvent.serializer()), handoffFixture.getValue("events"))
    }

    /** Hand-off answers, Finish on your Mac and Resume, recorded with their keys; failures thrown in order. */
    private class HandoffTransport(session: AidenBotSession) : AidenBotSessionTransport by FakeTransport(session) {
        data class Answer(val waitId: String, val request: AidenBotHandoffAnswerRequest, val key: UUID)
        val answers = mutableListOf<Answer>()
        val answerFailures = ArrayDeque<Exception>()
        val openKeys = mutableListOf<UUID>()
        var opened = true
        val unpauseKeys = mutableListOf<UUID>()
        val unpauseFailures = ArrayDeque<Exception>()
        var unpauseGate: CompletableDeferred<Unit>? = null
        var unpauseView = AidenBotSessionStateView(AidenBotSessionState.IDLE, false)
        val sent = mutableListOf<String>()

        override suspend fun send(botId: String, text: String, key: UUID, whenBusy: AidenStreamInputMode?): AidenBotSessionSendResponse {
            sent += text
            return AidenBotSessionSendResponse("1", false, AidenBotSessionState.RUNNING, false)
        }

        override suspend fun answerHandoff(
            botId: String,
            waitId: String,
            request: AidenBotHandoffAnswerRequest,
            key: UUID
        ): AidenBotHandoffAnswerReceipt {
            answers += Answer(waitId, request, key)
            answerFailures.removeFirstOrNull()?.let { throw it }
            return AidenBotHandoffAnswerReceipt(waitId)
        }

        override suspend fun openHandoffOnMac(botId: String, waitId: String, key: UUID): AidenBotHandoffOpenOnMacReceipt {
            openKeys += key
            return AidenBotHandoffOpenOnMacReceipt(waitId, opened)
        }

        override suspend fun unpause(botId: String, key: UUID): AidenBotSessionStateView {
            unpauseKeys += key
            unpauseGate?.await()
            unpauseFailures.removeFirstOrNull()?.let { throw it }
            return unpauseView
        }
    }

    @Test
    fun doneWithANoteAnswersTheCardOnceAndALostAnswerIsRetriedUnderItsKey() = runTest {
        val transport = HandoffTransport(handoffSession)
        val controller = AidenBotSessionController(handoffSession.botId, transport, backgroundScope)
        controller.refetch()
        val card = requireNotNull(controller.state.value.handoff)
        assertEquals(AidenBotComposerMode.HANDOFF_NOTE, controller.state.value.composerMode)
        assertTrue(controller.state.value.composerEnabled)

        transport.answerFailures += IOException("offline")
        assertFalse(controller.answerHandoff(AidenBotHandoffOutcome.DONE, "  The code was from 9:01.\n"))
        // It didn't reach the Mac: the card comes back with a word about it.
        assertEquals(card, controller.state.value.handoff)
        assertEquals(AidenBotSessionController.HANDOFF_NOT_SENT, controller.state.value.actionError)

        assertTrue(controller.answerHandoff(AidenBotHandoffOutcome.DONE, "The code was from 9:01."))
        assertNull(controller.state.value.handoff)
        assertEquals(2, transport.answers.size)
        assertEquals("the same answer replays its key", transport.answers[0].key, transport.answers[1].key)
        // The note goes out trimmed, exactly as the fixture's request.
        assertEquals(
            handoffFixture.getValue("answer").jsonObject.getValue("request"),
            json.encodeToJsonElement(AidenBotHandoffAnswerRequest.serializer(), transport.answers[1].request)
        )
        assertEquals(card.waitId, transport.answers[1].waitId)
        // Nothing waits any more: a second tap sends nothing.
        assertFalse(controller.answerHandoff(AidenBotHandoffOutcome.SKIPPED))
        assertEquals(2, transport.answers.size)
        assertEquals(AidenBotComposerMode.MESSAGE, controller.state.value.composerMode)
    }

    @Test
    fun aCardAnsweredElsewhereStaysGoneAndAnOverlongNoteIsNeverSent() = runTest {
        val transport = HandoffTransport(handoffSession)
        val controller = AidenBotSessionController(handoffSession.botId, transport, backgroundScope)
        controller.refetch()

        assertFalse(controller.answerHandoff(AidenBotHandoffOutcome.DONE, "n".repeat(AidenBotHandoffWire.MAX_NOTE_LENGTH + 1)))
        assertEquals(AidenBotSessionController.HANDOFF_NOTE_TOO_LONG, controller.state.value.actionError)
        assertTrue(transport.answers.isEmpty())
        assertNotEquals(null, controller.state.value.handoff)

        transport.answerFailures += serverError(409, AidenRemoteErrorCode.HANDOFF_EXPIRED)
        assertFalse(controller.answerHandoff(AidenBotHandoffOutcome.SKIPPED))
        assertNull("answered on the Mac or withdrawn", controller.state.value.handoff)
        assertEquals(AidenBotSessionController.HANDOFF_EXPIRED, controller.state.value.actionError)
    }

    @Test
    fun aCardThatTakesNoNoteHoldsTheComposerAndIsAnsweredOnlyBare() = runTest {
        val noNote = handoffSession.copy(handoff = handoffSession.handoff!!.copy(takesNote = false))
        val transport = HandoffTransport(noNote)
        val controller = AidenBotSessionController(noNote.botId, transport, backgroundScope)
        controller.refetch()
        assertEquals(AidenBotComposerMode.HELD_FOR_NO_NOTE, controller.state.value.composerMode)
        assertFalse("a code typed here would reach the Bot", controller.state.value.composerEnabled)
        assertFalse(controller.state.value.composerAnswersHandoff)

        assertFalse(controller.answerHandoff(AidenBotHandoffOutcome.DONE, "123456"))
        assertTrue("a note never leaves the phone for this card", transport.answers.isEmpty())
        assertNotEquals("the card still waits", null, controller.state.value.handoff)

        assertTrue(controller.answerHandoff(AidenBotHandoffOutcome.DONE))
        assertEquals(AidenBotHandoffAnswerRequest(AidenBotHandoffOutcome.DONE), transport.answers.single().request)
        assertEquals(AidenBotComposerMode.MESSAGE, controller.state.value.composerMode)
    }

    @Test
    fun aSignInIsFinishedOnTheMacOrSkippedNeverMarkedDone() = runTest {
        val signIn = handoffSession.copy(handoff = handoffSession.handoff!!.copy(kind = AidenBotHandoffKind.SIGN_IN, openUrl = null))
        val transport = HandoffTransport(signIn)
        val controller = AidenBotSessionController(signIn.botId, transport, backgroundScope)
        controller.refetch()
        assertEquals(AidenBotComposerMode.HELD_FOR_SIGN_IN, controller.state.value.composerMode)
        assertFalse("the composer waits for the Mac", controller.state.value.composerEnabled)

        assertFalse(controller.answerHandoff(AidenBotHandoffOutcome.DONE))
        assertTrue("a phone can't finish a sign-in", transport.answers.isEmpty())

        transport.opened = false
        assertTrue(controller.finishHandoffOnMac())
        assertEquals(AidenBotHandoffMacPrompt(signIn.handoff!!.waitId, opened = false), controller.state.value.handoffMacPrompt)
        assertNotEquals("the card stays", null, controller.state.value.handoff)

        assertTrue(controller.answerHandoff(AidenBotHandoffOutcome.SKIPPED))
        assertEquals(AidenBotHandoffAnswerRequest(AidenBotHandoffOutcome.SKIPPED), transport.answers.single().request)
        assertNull(controller.state.value.handoffMacPrompt)
    }

    @Test
    fun theFeedShowsAndSettlesTheCardAndAnnouncesEachNewOneOnce() = runTest {
        val controller = AidenBotSessionController(handoffSession.botId, HandoffTransport(handoffSession), backgroundScope)
        val announced = mutableListOf<String>()
        controller.onHandoffArrived = { announced += it.waitId }
        assertTrue(controller.handle(snapshotOf(handoffSession)))
        // The same card again in its own frame is not news.
        assertTrue(controller.handle(handoffEvents[0]))
        assertTrue(controller.handle(handoffEvents[1]))
        assertNull(controller.state.value.handoff)
        val next = AidenBotHandoff("0a1b2c3d-0000-4000-8000-000000000001", AidenBotHandoffKind.SIGN_IN, "Sign in to your bank")
        assertTrue(controller.handle(AidenBotSessionEvent(handoffSession.botId, handoffSession.epoch, 43, AidenBotSessionEventPayload.Handoff(next))))
        assertEquals(next, controller.state.value.handoff)
        assertEquals(listOf(handoffSession.handoff!!.waitId, next.waitId), announced)
    }

    @Test
    fun aPausedBotTakesNoMessageAndResumeWaitsForTheMacsWord() = runTest {
        val transport = HandoffTransport(pausedSession)
        val controller = AidenBotSessionController(pausedSession.botId, transport, backgroundScope)
        controller.refetch()
        assertTrue(controller.state.value.isPaused)
        assertFalse(controller.state.value.canSend)
        assertEquals(AidenBotComposerMode.PAUSED, controller.state.value.composerMode)
        assertFalse(controller.send("Are you there?"))
        assertTrue(transport.sent.isEmpty())

        // A lost Resume changes nothing and keeps its key.
        transport.unpauseFailures += IOException("offline")
        assertFalse(controller.unpause())
        assertTrue(controller.state.value.isPaused)
        assertEquals(AidenBotSessionController.UNREACHABLE, controller.state.value.actionError)

        // Nothing is shown before the Mac answers; a reply the pause cut short comes back interrupted.
        transport.unpauseGate = CompletableDeferred()
        transport.unpauseView = AidenBotSessionStateView(AidenBotSessionState.INTERRUPTED, true)
        val resumed = async { controller.unpause() }
        runCurrent()
        assertTrue(controller.state.value.isUnpausing)
        assertTrue(controller.state.value.isPaused)
        assertFalse("one Resume at a time", controller.unpause())
        transport.unpauseGate!!.complete(Unit)
        assertTrue(resumed.await())
        assertEquals(AidenBotSessionState.INTERRUPTED, controller.state.value.state)
        assertTrue(controller.state.value.isInterrupted)
        assertEquals(transport.unpauseKeys[0], transport.unpauseKeys[1])
        assertEquals(2, transport.unpauseKeys.size)
    }

    @Test
    fun aPausedChatOffersResumeOnlyToAPhoneThatMayChangeBotsWhileTheMacIsConnected() = runTest {
        val controller = AidenBotSessionController(pausedSession.botId, HandoffTransport(pausedSession), backgroundScope)
        assertFalse("before the Mac's snapshot", aidenBotPausedChatOffersResume(canWriteBots = true, ui = controller.state.value))
        controller.refetch()
        val paused = controller.state.value
        assertTrue(paused.isPaused)
        assertTrue(aidenBotPausedChatOffersResume(canWriteBots = true, ui = paused))
        assertFalse("a phone that may only read Bots", aidenBotPausedChatOffersResume(canWriteBots = false, ui = paused))
        assertFalse("while the feed reconnects", aidenBotPausedChatOffersResume(canWriteBots = true, ui = paused.copy(streamDown = true)))
    }

    @Test
    fun aFeedThatOpenedBeforeTheHandoffsGrantOpensAgainAndShowsTheCard() = runTest {
        // The Mac shapes a feed by the grants this phone held when it opened. A chat opened while
        // connecting can open its feed before `bot:handoffs` is negotiated: no card on that feed.
        val beforeGrant = handoffSession.copy(handoff = null)
        val reads = FakeTransport(beforeGrant)
        var opens = 0
        val closed = mutableListOf<Int>()
        val transport = object : AidenBotSessionTransport by reads {
            override fun events(botId: String): Flow<AidenBotSessionEvent> = flow {
                val open = ++opens
                emit(snapshotOf(reads.session))
                try {
                    awaitCancellation()
                } finally {
                    closed += open
                }
            }
        }
        val controller = AidenBotSessionController(beforeGrant.botId, transport, backgroundScope)
        controller.reopenFeed()
        runCurrent()
        assertEquals("nothing to reopen before the chat follows", 0, opens)

        controller.start()
        runCurrent()
        assertEquals(1, opens)
        assertNull(controller.state.value.handoff)
        assertTrue(controller.send("Still there?"))
        runCurrent()
        assertEquals(1, reads.sends.size)

        // The grant is saved: the same chat reads the Mac again and gets the card, and the
        // message it already took isn't sent again.
        reads.session = handoffSession
        controller.reopenFeed()
        runCurrent()
        assertEquals(2, opens)
        assertEquals("the first feed is closed", listOf(1), closed)
        assertEquals(handoffSession.handoff, controller.state.value.handoff)
        assertEquals(AidenBotComposerMode.HANDOFF_NOTE, controller.state.value.composerMode)
        assertEquals(1, reads.sends.size)

        controller.stopFollowing()
        runCurrent()
        controller.reopenFeed()
        runCurrent()
        assertEquals("a closed chat opens no feed", 2, opens)
    }
}
