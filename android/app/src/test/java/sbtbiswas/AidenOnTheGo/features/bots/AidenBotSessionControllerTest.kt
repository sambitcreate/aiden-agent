package sbtbiswas.AidenOnTheGo.features.bots

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
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
        override suspend fun requestConnection(botId: String, pluginId: String, key: UUID) =
            AidenBotConnectionRequestReceipt(pluginId, "Google Calendar", AidenBotConnectionRequestStatus.SENT)
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
        val (snapshot, partial, entry, state, closed, newEpoch) = fixtureEvents.let { Six(it) }

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

    private data class Six<T>(val list: List<T>) {
        operator fun component1() = list[0]
        operator fun component2() = list[1]
        operator fun component3() = list[2]
        operator fun component4() = list[3]
        operator fun component5() = list[4]
        operator fun component6() = list[5]
    }
}
