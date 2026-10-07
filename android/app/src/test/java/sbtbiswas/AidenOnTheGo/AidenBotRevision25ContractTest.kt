package sbtbiswas.AidenOnTheGo

import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteProtocol

/** Revision 25 Bot DTOs against the shared contract fixture, through the strict client codec. */
class AidenBotRevision25ContractTest {
    private val json = AidenBotWireJson.json

    private val fixture: JsonObject by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json")) { "contract.json" }
            .bufferedReader().use { it.readText() }
        json.parseToJsonElement(text).jsonObject
    }

    /** decode → encode → decode: the second decode equals the first, and the wire is unchanged. */
    private fun <T> roundTrip(serializer: KSerializer<T>, element: JsonElement): T {
        val decoded = json.decodeFromJsonElement(serializer, element)
        val encoded = json.encodeToJsonElement(serializer, decoded)
        assertEquals(element, encoded)
        assertEquals(decoded, json.decodeFromJsonElement(serializer, encoded))
        return decoded
    }

    private fun pair(key: String, part: String) = fixture.getValue(key).jsonObject.getValue(part)

    @Test
    fun fixtureIsRevision25AndAdvertisesTheBotFeatures() {
        assertEquals(25, (fixture.getValue("contractRevision") as JsonPrimitive).content.toInt())
        val server = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
            .decodeFromJsonElement(AidenServer.serializer(), fixture.getValue("server"))
        assertTrue(server.supportsBotDurableSession)
        assertTrue(server.supportsBotRoutines)
        assertTrue(server.supportsBotConnectionRequests)
        assertTrue(server.supportsBotPresets)
        assertTrue(server.features.contains(AidenRemoteProtocol.BOT_DELETE_FEATURE))
    }

    @Test
    fun changedBotDtosRoundTrip() {
        val summary = roundTrip(AidenBotSummary.serializer(), fixture.getValue("botSummary"))
        assertEquals(AidenBotSessionState.INTERRUPTED, summary.sessionState)
        assertEquals(AidenBotAvatarColor.ROSE, (summary.avatar.semantic as AidenBotSemanticAvatar.Recipe).recipe.color)
        val list = roundTrip(AidenBotList.serializer(), fixture.getValue("botList"))
        assertEquals(listOf(summary), list.bots)
        val detail = roundTrip(AidenBotDetail.serializer(), fixture.getValue("botDetail"))
        assertEquals(AidenBotSessionState.IDLE, detail.sessionState)
        roundTrip(AidenBotAvatarView.serializer(), fixture.getValue("botAvatar"))
        val createRequest = roundTrip(AidenBotCreateRequest.serializer(), pair("botCreate", "request"))
        assertNull(createRequest.access)
        assertEquals(AidenBotSessionState.NEEDS_MODEL, roundTrip(AidenBotDetail.serializer(), pair("botCreate", "response")).sessionState)
        roundTrip(AidenBotCapabilityCatalog.serializer(), fixture.getValue("botCapabilityCatalog"))
    }

    @Test
    fun sessionDtosRoundTrip() {
        val session = roundTrip(AidenBotSession.serializer(), fixture.getValue("botSession"))
        assertTrue(session.interrupted)
        assertEquals("Your first meeting is at 9", session.partial)
        assertEquals(
            listOf("notice", "message", "message", "message", "connect_card", "message"),
            session.entries.map {
                when (it) {
                    is AidenBotSessionEntry.Message -> "message"
                    is AidenBotSessionEntry.ConnectCard -> "connect_card"
                    is AidenBotSessionEntry.Notice -> "notice"
                }
            }
        )
        assertEquals("Morning brief", (session.entries[3] as AidenBotSessionEntry.Message).label)
        assertEquals(true, (session.entries.last() as AidenBotSessionEntry.Message).interrupted)
        val needsModel = roundTrip(AidenBotSession.serializer(), fixture.getValue("botSessionNeedsModel"))
        assertEquals(AidenBotSessionState.NEEDS_MODEL, needsModel.state)

        val events = roundTrip(ListSerializer(AidenBotSessionEvent.serializer()), fixture.getValue("botSessionEvents"))
        assertEquals(listOf("snapshot", "partial", "entry", "state", "closed", "state"), events.map { it.type })
        assertEquals(AidenBotSessionBlock.ACCESS_CHANGED, (events[3].payload as AidenBotSessionEventPayload.State).view.blocked)

        roundTrip(AidenBotSessionSendRequest.serializer(), pair("botSessionSend", "request"))
        assertFalse(roundTrip(AidenBotSessionSendResponse.serializer(), pair("botSessionSend", "response")).deduped)
        for (key in listOf("botSessionResume", "botSessionDismiss")) {
            roundTrip(AidenBotEmptyRequest.serializer(), pair(key, "request"))
            roundTrip(AidenBotSessionStateView.serializer(), pair(key, "response"))
        }
    }

    @Test
    fun routineConnectionAndPresetDtosRoundTrip() {
        val routines = roundTrip(AidenBotRoutineList.serializer(), fixture.getValue("botRoutines")).routines
        assertEquals(AidenBotRoutineSchedule.Weekdays("08:00"), routines[0].schedule)
        assertEquals(AidenBotRoutineSchedule.Weekly(listOf(0), "09:00"), routines[1].schedule)
        assertEquals("Weekdays at 8:00 AM", routines[0].label)
        roundTrip(AidenBotRoutineCreateRequest.serializer(), pair("botRoutineCreate", "request"))
        roundTrip(AidenBotRoutine.serializer(), pair("botRoutineCreate", "response"))
        assertEquals(false, roundTrip(AidenBotRoutineUpdateRequest.serializer(), pair("botRoutineUpdate", "request")).enabled)
        roundTrip(AidenBotRoutine.serializer(), pair("botRoutineUpdate", "response"))
        roundTrip(AidenBotConnectionRequest.serializer(), pair("botConnectionRequest", "request"))
        roundTrip(AidenBotConnectionRequestReceipt.serializer(), pair("botConnectionRequest", "response"))
        val presets = roundTrip(AidenBotPresetList.serializer(), fixture.getValue("botPresets")).presets
        assertEquals("Weekdays at 8:00 AM", presets.first().suggestedRoutine?.label)
        roundTrip(AidenBotPresetCreateRequest.serializer(), pair("botPresetCreate", "request"))
        val created = roundTrip(AidenBotPresetCreateResult.serializer(), pair("botPresetCreate", "response"))
        assertEquals(AidenBotSessionState.NEEDS_MODEL, created.bot.sessionState)
    }

    @Test
    fun parsersRejectRemovedFieldsUnknownColoursAndInconsistentState() {
        val list = fixture.getValue("botList").jsonObject
        val withFavorites = JsonObject(list + ("favorites" to json.parseToJsonElement("""{"botIds":[],"revision":"r"}""")))
        assertThrows(Exception::class.java) { json.decodeFromJsonElement(AidenBotList.serializer(), withFavorites) }

        val summary = fixture.getValue("botSummary").jsonObject
        val archived = JsonObject(summary + ("health" to JsonPrimitive("archived")))
        assertThrows(Exception::class.java) { json.decodeFromJsonElement(AidenBotSummary.serializer(), archived) }

        val avatar = fixture.getValue("botAvatar").jsonObject
        val semantic = avatar.getValue("semantic").jsonObject
        val teal = JsonObject(avatar + ("semantic" to JsonObject(semantic + ("color" to JsonPrimitive("teal")))))
        assertThrows(Exception::class.java) { json.decodeFromJsonElement(AidenBotAvatarView.serializer(), teal) }
        val legacy = JsonObject(avatar + ("semantic" to JsonPrimitive("orbit")))
        assertThrows(Exception::class.java) { json.decodeFromJsonElement(AidenBotAvatarView.serializer(), legacy) }

        val session = fixture.getValue("botSession").jsonObject
        val disagreeing = JsonObject(session + ("interrupted" to JsonPrimitive(false)))
        assertThrows(Exception::class.java) { json.decodeFromJsonElement(AidenBotSession.serializer(), disagreeing) }
        val blockedIdle = fixture.getValue("botSessionNeedsModel").jsonObject + ("blocked" to JsonPrimitive("access_changed"))
        assertThrows(Exception::class.java) { json.decodeFromJsonElement(AidenBotSession.serializer(), JsonObject(blockedIdle)) }

        val event = fixture.getValue("botSessionEvents").jsonArray[1].jsonObject
        assertThrows(Exception::class.java) {
            json.decodeFromJsonElement(AidenBotSessionEvent.serializer(), JsonObject(event + ("extra" to JsonPrimitive(1))))
        }
        assertThrows(Exception::class.java) {
            json.decodeFromJsonElement(AidenBotRoutineSchedule.serializer(), json.parseToJsonElement("""{"kind":"weekly","days":[3,1],"time":"09:00"}"""))
        }
        assertThrows(Exception::class.java) {
            json.decodeFromJsonElement(AidenBotRoutineSchedule.serializer(), json.parseToJsonElement("""{"kind":"daily","time":"24:00"}"""))
        }
    }
}
