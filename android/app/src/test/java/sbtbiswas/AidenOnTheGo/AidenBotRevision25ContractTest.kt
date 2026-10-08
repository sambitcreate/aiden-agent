package sbtbiswas.AidenOnTheGo

import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
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
        assertEquals(
            listOf("snapshot", "partial", "entry", "state", "closed", "state", "question", "question"),
            events.map { it.type }
        )
        assertEquals(AidenBotSessionBlock.ACCESS_CHANGED, (events[3].payload as AidenBotSessionEventPayload.State).view.blocked)
        assertEquals(null, (events.last().payload as AidenBotSessionEventPayload.Question).question)
        val asked = (events[events.size - 2].payload as AidenBotSessionEventPayload.Question).question
        assertEquals("5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c", asked?.waitId)
        assertEquals("Blue", asked?.questions?.first()?.options?.first()?.label)

        roundTrip(AidenBotSessionSendRequest.serializer(), pair("botSessionSend", "request"))
        assertFalse(roundTrip(AidenBotSessionSendResponse.serializer(), pair("botSessionSend", "response")).deduped)
        for (key in listOf("botSessionResume", "botSessionDismiss")) {
            roundTrip(AidenBotEmptyRequest.serializer(), pair(key, "request"))
            roundTrip(AidenBotSessionStateView.serializer(), pair(key, "response"))
        }
        val answer = AidenQuestionContractCodec.parseRespondRequest(pair("botSessionQuestionAnswer", "request"))
        assertEquals(listOf(AidenQuestionAnswer.Option(0, "Blue")), answer.answers)
        assertEquals(
            "5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c",
            roundTrip(AidenBotQuestionAnswerReceipt.serializer(), pair("botSessionQuestionAnswer", "response")).waitId
        )
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

    private fun JsonObject.with(vararg changes: Pair<String, JsonElement>) = JsonObject(this + changes)

    private fun <T> rejects(serializer: KSerializer<T>, element: JsonElement) {
        assertThrows(Exception::class.java) { json.decodeFromJsonElement(serializer, element) }
    }

    /** Values the host parsers in `aiden-remote-protocol.ts` refuse are refused here too. */
    @Test
    fun sessionEntriesFollowTheHostGrammar() {
        val session = fixture.getValue("botSession").jsonObject
        val entries = session.getValue("entries").jsonArray
        val message = entries.first { it.jsonObject["type"] == JsonPrimitive("message") }.jsonObject
        val card = entries.first { it.jsonObject["type"] == JsonPrimitive("connect_card") }.jsonObject
        val entry = AidenBotSessionEntry.serializer()

        // Only an assistant answer can be cut off, and only as `true`.
        rejects(entry, message.with("role" to JsonPrimitive("assistant"), "interrupted" to JsonPrimitive(false)))
        rejects(entry, message.with("role" to JsonPrimitive("user"), "interrupted" to JsonPrimitive(true)))
        // Entry ids use the identifier grammar; routine labels stop at 120 characters.
        rejects(entry, message.with("id" to JsonPrimitive("entry 1")))
        rejects(entry, message.with("label" to JsonPrimitive("x".repeat(121))))
        assertEquals("x".repeat(120), (json.decodeFromJsonElement(entry, message.with("label" to JsonPrimitive("x".repeat(120)))) as AidenBotSessionEntry.Message).label)
        // Connect cards: lowercase plugin and icon ids, and a 1–280 character reason.
        rejects(entry, card.with("pluginId" to JsonPrimitive("Google_Calendar")))
        rejects(entry, card.with("iconId" to JsonPrimitive("-gmail")))
        rejects(entry, card.with("reason" to JsonPrimitive("")))
        rejects(entry, card.with("reason" to JsonPrimitive("r".repeat(281))))
        rejects(entry, card.with("status" to JsonPrimitive("failed")))
        // Epochs are 1–64 of `[A-Za-z0-9_-]`; seq is a non-negative safe integer.
        rejects(AidenBotSession.serializer(), session.with("epoch" to JsonPrimitive("epoch:1")))
        rejects(AidenBotSession.serializer(), session.with("epoch" to JsonPrimitive("e".repeat(65))))
        rejects(AidenBotSession.serializer(), session.with("seq" to JsonPrimitive(-1)))
        rejects(AidenBotSession.serializer(), session.with("seq" to JsonPrimitive("12")))
        rejects(AidenBotSession.serializer(), session.with("hasOlder" to JsonPrimitive("false")))
        // More than 200 entries is out of bounds.
        val many = JsonArray((0..200).map { message.with("id" to JsonPrimitive("m_$it")) })
        rejects(AidenBotSession.serializer(), session.with("entries" to many))
        // A blank message is never sent.
        assertThrows(Exception::class.java) { AidenBotSessionSendRequest("   ") }
    }

    @Test
    fun routinesAndPresetsFollowTheHostBounds() {
        val routine = fixture.getValue("botRoutines").jsonObject.getValue("routines").jsonArray[0].jsonObject
        val serializer = AidenBotRoutine.serializer()
        // The host stores up to 32,768 characters and may return an empty message.
        assertEquals("", json.decodeFromJsonElement(serializer, routine.with("message" to JsonPrimitive(""))).message)
        assertEquals(32_768, json.decodeFromJsonElement(serializer, routine.with("message" to JsonPrimitive("m".repeat(32_768)))).message.length)
        rejects(serializer, routine.with("message" to JsonPrimitive("m".repeat(32_769))))
        // Long IANA zones are fine; padded ones are not.
        val zone = "America/Argentina/ComodRivadavia/" + "x".repeat(60)
        assertEquals(zone, json.decodeFromJsonElement(serializer, routine.with("timezone" to JsonPrimitive(zone))).timezone)
        rejects(serializer, routine.with("timezone" to JsonPrimitive(" UTC")))
        rejects(serializer, routine.with("lastError" to JsonPrimitive("e".repeat(501))))
        rejects(serializer, routine.with("lastResult" to JsonPrimitive("failed")))
        rejects(serializer, routine.with("id" to JsonPrimitive("routine 1")))
        // The host refuses blank names and messages.
        val schedule = AidenBotRoutineSchedule.Daily("08:00")
        assertThrows(Exception::class.java) { AidenBotRoutineCreateRequest(name = " ", schedule = schedule, message = "Brief me") }
        assertThrows(Exception::class.java) { AidenBotRoutineUpdateRequest(message = "  ") }

        val presets = fixture.getValue("botPresets").jsonObject
        val preset = presets.getValue("presets").jsonArray[0].jsonObject
        val chip = preset.getValue("suggestedConnections").jsonArray[0].jsonObject
        fun withPreset(changed: JsonObject) = presets.with("presets" to JsonArray(listOf(changed)))
        rejects(AidenBotPresetList.serializer(), withPreset(preset.with("id" to JsonPrimitive("Chief Of Staff"))))
        rejects(AidenBotPresetList.serializer(), withPreset(preset.with("subtitle" to JsonPrimitive(""))))
        rejects(
            AidenBotPresetList.serializer(),
            withPreset(preset.with("suggestedConnections" to JsonArray((0..8).map { chip.with("pluginId" to JsonPrimitive("p$it")) })))
        )
        assertThrows(Exception::class.java) { AidenBotPresetCreateRequest("Chief") }
        assertThrows(Exception::class.java) { AidenBotConnectionRequest("Google Calendar") }
    }
}
