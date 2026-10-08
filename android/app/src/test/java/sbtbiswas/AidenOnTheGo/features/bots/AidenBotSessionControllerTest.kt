package sbtbiswas.AidenOnTheGo.features.bots

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.onCompletion
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
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorEnvelope
import java.io.IOException
import java.util.UUID

@OptIn(ExperimentalCoroutinesApi::class)
class AidenBotSessionControllerTest {
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

        override suspend fun session(botId: String): AidenBotSession {
            sessionReads += 1
            return session
        }

        override fun events(botId: String): Flow<AidenBotSessionEvent> = emptyFlow()

        override suspend fun send(botId: String, text: String, key: UUID): AidenBotSessionSendResponse {
            sends += text to key
            return AidenBotSessionSendResponse("1", false, AidenBotSessionState.RUNNING, false)
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

        override suspend fun dismiss(botId: String, key: UUID) = AidenBotSessionStateView(AidenBotSessionState.IDLE, false)
        override suspend fun stop(botId: String, key: UUID) = AidenBotSessionStateView(AidenBotSessionState.IDLE, false)

        val answerKeys = mutableListOf<UUID>()
        var failNextAnswer = false

        override suspend fun answerQuestion(
            botId: String,
            waitId: String,
            request: AidenQuestionRespondRequest,
            key: UUID
        ): AidenBotQuestionAnswerReceipt {
            answerKeys += key
            if (failNextAnswer) {
                failNextAnswer = false
                throw IOException("offline")
            }
            return AidenBotQuestionAnswerReceipt(waitId)
        }
        override suspend fun requestConnection(botId: String, pluginId: String, key: UUID) =
            AidenBotConnectionRequestReceipt(pluginId, "Google Calendar", AidenBotConnectionRequestStatus.SENT)
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
        advanceUntilIdle()
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

        // A later, separate Resume is a new logical action with a new key.
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

    @Test
    fun sendKeepsItsKeyForARetryOfTheSameText() = runTest {
        val idle = needsModelSession.copy(state = AidenBotSessionState.IDLE)
        val transport = object : AidenBotSessionTransport by FakeTransport(idle) {
            val keys = mutableListOf<UUID>()
            var fail = true
            override suspend fun session(botId: String) = idle
            override suspend fun send(botId: String, text: String, key: UUID): AidenBotSessionSendResponse {
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
        assertFalse(controller.send("Plan my week"))
        assertTrue(controller.send("Plan my week"))
        assertEquals(transport.keys[0], transport.keys[1])
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
}
