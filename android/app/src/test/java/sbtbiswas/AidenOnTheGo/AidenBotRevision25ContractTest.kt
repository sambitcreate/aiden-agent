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
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteProtocol
import kotlinx.serialization.json.jsonPrimitive

/**
 * Revision 25 Bot DTOs, and the revision 27 memory, proactivity and session card DTOs, against
 * the shared contract fixture, through the strict client codec.
 */
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
        assertTrue((fixture.getValue("contractRevision") as JsonPrimitive).content.toInt() >= 25)
        val server = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
            .decodeFromJsonElement(AidenServer.serializer(), fixture.getValue("server"))
        assertTrue(server.supportsBotDurableSession)
        assertTrue(server.supportsBotRoutines)
        assertTrue(server.supportsBotConnectionRequests)
        assertTrue(server.supportsBotPresets)
        assertTrue(server.features.contains(AidenRemoteProtocol.BOT_DELETE_FEATURE))
    }

    @Test
    fun fixtureIsRevision27AndAdvertisesMemoryAndProactivity() {
        assertTrue((fixture.getValue("contractRevision") as JsonPrimitive).content.toInt() >= 27)
        val server = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
            .decodeFromJsonElement(AidenServer.serializer(), fixture.getValue("server"))
        assertTrue(server.supportsBotMemory)
        assertTrue(server.supportsBotProactive)
        // Either feature is enough to ask the Mac for `bot:cards`.
        assertTrue(server.offersBotCards)
        assertFalse(server.copy(features = server.features - AidenRemoteProtocol.BOT_MEMORY_FEATURE - AidenRemoteProtocol.BOT_PROACTIVE_FEATURE).offersBotCards)
        // The retired greeting is gone from every Bot shape the host sends.
        for (element in listOf(fixture.getValue("botDetail"), pair("botCreate", "request"), pair("botCreate", "response"), pair("botIdentity", "response"))) {
            assertFalse(element.jsonObject.containsKey("openingGreeting"))
        }
    }

    @Test
    fun memoryDtosRoundTrip() {
        val memory = roundTrip(AidenBotMemory.serializer(), fixture.getValue("botMemory"))
        assertTrue(memory.readable)
        assertEquals(listOf("Prefers short answers.", "Has two kids, Mia (8) and Leo (5)."), memory.user.entries.map { it.text })
        assertEquals(1_375, memory.user.limitChars)
        assertEquals(2_200, memory.memory.limitChars)
        assertEquals(3, memory.entryCount)

        val request = roundTrip(AidenBotMemoryEditRequest.serializer(), pair("botMemoryEdit", "request"))
        assertEquals(
            AidenBotMemoryEdit.Replace(AidenBotMemoryTarget.USER, "0f1e2d3c4b5a6978", "Prefers short, friendly answers."),
            request.edit
        )
        val response = roundTrip(AidenBotMemoryEditResponse.serializer(), pair("botMemoryEdit", "response"))
        // A replaced entry comes back under a new id.
        assertEquals("5e5e5e5e5e5e5e5e", response.view.user.entries.first().id)
        assertEquals(memory.botId, response.view.botId)

        // The other edit kinds use the same `kind` discriminator.
        assertEquals(
            json.parseToJsonElement("""{"edit":{"kind":"remove","target":"memory","entryId":"a1b2c3d4e5f60718"}}"""),
            json.encodeToJsonElement(
                AidenBotMemoryEditRequest.serializer(),
                AidenBotMemoryEditRequest(AidenBotMemoryEdit.Remove(AidenBotMemoryTarget.MEMORY, "a1b2c3d4e5f60718"))
            )
        )
        assertEquals(
            json.parseToJsonElement("""{"edit":{"kind":"clear"}}"""),
            json.encodeToJsonElement(AidenBotMemoryEditRequest.serializer(), AidenBotMemoryEditRequest(AidenBotMemoryEdit.Clear))
        )

        // The error codes the fixture lists decode to the shared envelope's codes.
        val codes = fixture.getValue("botMemoryEdit").jsonObject.getValue("errors").jsonArray
            .map { AidenRemoteErrorCode(it.jsonObject.getValue("code").jsonPrimitive.content) }
        assertTrue(AidenRemoteErrorCode.V1_KNOWN.containsAll(codes))
        assertEquals(
            listOf(AidenRemoteErrorCode.MEMORY_ENTRY_NOT_FOUND, AidenRemoteErrorCode.MEMORY_OVER_BUDGET, AidenRemoteErrorCode.MEMORY_BLOCKED),
            codes
        )
    }

    @Test
    fun memoryFollowsTheHostBounds() {
        val view = fixture.getValue("botMemory").jsonObject
        val user = view.getValue("user").jsonObject
        val entry = user.getValue("entries").jsonArray[0].jsonObject
        fun withEntry(changed: JsonObject) = view.with("user" to user.with("entries" to JsonArray(listOf(changed))))
        val serializer = AidenBotMemory.serializer()

        rejects(serializer, withEntry(entry.with("id" to JsonPrimitive("0F1E2D3C4B5A6978"))))
        rejects(serializer, withEntry(entry.with("text" to JsonPrimitive(""))))
        rejects(serializer, withEntry(entry.with("text" to JsonPrimitive("t".repeat(501)))))
        rejects(serializer, withEntry(entry.with("source" to JsonPrimitive("tool"))))
        rejects(serializer, view.with("revision" to JsonPrimitive("rev_1")))
        rejects(serializer, view.with("readable" to JsonPrimitive("true")))
        rejects(serializer, view.with("user" to user.with("limitChars" to JsonPrimitive(0))))
        rejects(serializer, view.with("user" to user.with("entries" to JsonArray(listOf(entry, entry)))))
        // An unreadable memory still decodes, so the page can offer Erase.
        assertFalse(json.decodeFromJsonElement(serializer, view.with("readable" to JsonPrimitive(false))).readable)
        // An error-shaped edit response is not a success.
        rejects(AidenBotMemoryEditResponse.serializer(), pair("botMemoryEdit", "response").jsonObject.with("ok" to JsonPrimitive(false)))
        // A person's replacement is trimmed, non-empty and at most 500 characters.
        assertThrows(Exception::class.java) { AidenBotMemoryEdit.Replace(AidenBotMemoryTarget.USER, "0f1e2d3c4b5a6978", " padded ") }
        assertThrows(Exception::class.java) { AidenBotMemoryEdit.Replace(AidenBotMemoryTarget.USER, "0f1e2d3c4b5a6978", "") }
        assertThrows(Exception::class.java) { AidenBotMemoryEdit.Replace(AidenBotMemoryTarget.USER, "0f1e2d3c4b5a6978", "x".repeat(501)) }
    }

    @Test
    fun proactivityDtosRoundTrip() {
        val decision = roundTrip(AidenBotRoutineProposalRespondRequest.serializer(), pair("botRoutineProposalRespond", "request"))
        assertEquals(AidenBotRoutineProposalDecision.ACCEPT, decision.decision)
        val result = roundTrip(AidenBotRoutineProposalRespondResult.serializer(), pair("botRoutineProposalRespond", "response"))
        assertEquals(AidenBotRoutineProposalOutcome.ACCEPTED, result.status)
        assertEquals("task_fixture_routine_03", result.routineId)
        // Only an accepted proposal names its routine, and always does.
        rejects(AidenBotRoutineProposalRespondResult.serializer(), json.parseToJsonElement("""{"status":"accepted"}"""))
        rejects(AidenBotRoutineProposalRespondResult.serializer(), json.parseToJsonElement("""{"status":"dismissed","routineId":"task_1"}"""))
        assertNull(json.decodeFromJsonElement(AidenBotRoutineProposalRespondResult.serializer(), json.parseToJsonElement("""{"status":"dismissed"}""")).routineId)

        val suggestions = roundTrip(AidenBotRoutineSuggestionList.serializer(), fixture.getValue("botRoutineSuggestions")).suggestions
        val checkIn = suggestions.single()
        assertEquals("Daily check-in", checkIn.name)
        assertEquals(AidenBotRoutineSchedule.Daily("09:00"), checkIn.schedule)
        assertEquals("Every day at 9:00 AM", checkIn.label)

        val feed = roundTrip(AidenBotRoutineNotificationList.serializer(), fixture.getValue("botRoutineNotifications"))
        val run = feed.notifications.single()
        assertEquals("run_fixture_bot_01", run.id)
        assertEquals("Scout", run.botName)
        assertEquals("Morning brief", run.routineName)
        assertEquals(AidenBotRoutineNotificationStatus.SUCCEEDED, run.status)
        assertEquals(java.time.Instant.parse("2026-08-19T15:01:00Z"), feed.now)
        val raw = fixture.getValue("botRoutineNotifications").jsonObject
        val item = raw.getValue("notifications").jsonArray[0].jsonObject
        rejects(AidenBotRoutineNotificationList.serializer(), raw.with("notifications" to JsonArray(listOf(item.with("status" to JsonPrimitive("silent"))))))
        rejects(AidenBotRoutineNotificationList.serializer(), raw.with("notifications" to JsonArray(listOf(item.with("preview" to JsonPrimitive("p".repeat(161)))))))
        rejects(AidenBotRoutineNotificationList.serializer(), raw.with("notifications" to JsonArray(listOf(item, item))))
        rejects(AidenBotRoutineNotificationList.serializer(), JsonObject(raw - "now"))
    }

    @Test
    fun sessionCardsRoundTripAndFollowTheHostGrammar() {
        val session = roundTrip(AidenBotSession.serializer(), fixture.getValue("botSessionCards"))
        val memory = session.entries[0] as AidenBotSessionEntry.MemoryUpdate
        assertEquals("entry_20", memory.id)
        val pending = session.entries[1] as AidenBotSessionEntry.RoutineProposal
        assertEquals(AidenBotRoutineProposalStatus.PENDING, pending.status)
        assertEquals("7d0c5c8e-2f0b-4c4e-9a59-3b6f1f0e9a11", pending.proposalId)
        assertNull(pending.routineId)
        val accepted = session.entries[2] as AidenBotSessionEntry.RoutineProposal
        assertEquals(AidenBotRoutineProposalStatus.ACCEPTED, accepted.status)
        assertEquals("task_fixture_routine_02", accepted.routineId)

        val raw = fixture.getValue("botSessionCards").jsonObject.getValue("entries").jsonArray
        val entry = AidenBotSessionEntry.serializer()
        val update = raw[0].jsonObject
        val card = raw[1].jsonObject
        rejects(entry, update.with("text" to JsonPrimitive("Saved")))
        rejects(entry, card.with("proposalId" to JsonPrimitive("7D0C5C8E-2F0B-4C4E-9A59-3B6F1F0E9A11")))
        rejects(entry, card.with("status" to JsonPrimitive("expired")))
        rejects(entry, card.with("routineId" to JsonPrimitive("task_1")))
        rejects(entry, card.with("label" to JsonPrimitive("l".repeat(121))))
        rejects(entry, card.with("prompt" to JsonPrimitive("")))
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
                    is AidenBotSessionEntry.FailedTurn -> "failed_turn"
                    is AidenBotSessionEntry.MemoryUpdate -> "memory_update"
                    is AidenBotSessionEntry.RoutineProposal -> "routine_proposal"
                }
            }
        )
        assertEquals("Morning brief", (session.entries[3] as AidenBotSessionEntry.Message).label)
        assertEquals(true, (session.entries.last() as AidenBotSessionEntry.Message).interrupted)
        val needsModel = roundTrip(AidenBotSession.serializer(), fixture.getValue("botSessionNeedsModel"))
        assertEquals(AidenBotSessionState.NEEDS_MODEL, needsModel.state)

        val events = roundTrip(ListSerializer(AidenBotSessionEvent.serializer()), fixture.getValue("botSessionEvents"))
        assertEquals(
            listOf("snapshot", "partial", "entry", "state", "closed", "state", "question", "question", "approval", "approval"),
            events.map { it.type }
        )
        assertEquals(AidenBotSessionBlock.ACCESS_CHANGED, (events[3].payload as AidenBotSessionEventPayload.State).view.blocked)
        val questions = events.mapNotNull { (it.payload as? AidenBotSessionEventPayload.Question) }
        assertEquals(null, questions.last().question)
        val asked = questions.first().question
        assertEquals("5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c", asked?.waitId)
        assertEquals("Blue", asked?.questions?.first()?.options?.first()?.label)
        // A waiting tool approval, then the frame that settles it.
        val approvals = events.mapNotNull { (it.payload as? AidenBotSessionEventPayload.Approval) }
        val waiting = approvals.first().approval
        assertEquals("8d1e2f3a-4b5c-4d6e-9f70-a1b2c3d4e5f6", waiting?.waitId)
        assertEquals("mcp__mail__send_email", waiting?.toolName)
        assertEquals(true, waiting?.canAllow)
        assertNull(approvals.last().approval)
        // Nothing waits in the fixture sessions, and `approval: null` is written back explicitly.
        assertNull(session.approval)
        assertNull(needsModel.approval)

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
        // Cron skips the 29th–31st in shorter months, so monthly routines stop at the 28th.
        assertEquals(
            AidenBotRoutineSchedule.Monthly(28, "08:00"),
            json.decodeFromJsonElement(AidenBotRoutineSchedule.serializer(), json.parseToJsonElement("""{"kind":"monthly","day":28,"time":"08:00"}""")),
        )
        for (day in 29..31) {
            assertThrows(Exception::class.java) {
                json.decodeFromJsonElement(AidenBotRoutineSchedule.serializer(), json.parseToJsonElement("""{"kind":"monthly","day":$day,"time":"08:00"}"""))
            }
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

    /** A session always carries `approval`, and an approval has exactly the host's keys and bounds. */
    @Test
    fun sessionApprovalIsRequiredAndStrict() {
        val session = fixture.getValue("botSession").jsonObject
        val frame = fixture.getValue("botSessionEvents").jsonArray
            .first { it.jsonObject["type"] == JsonPrimitive("approval") }.jsonObject
        val waiting = frame.getValue("payload").jsonObject.getValue("approval").jsonObject

        // A session carrying a waiting approval round-trips with it.
        val carrying = roundTrip(AidenBotSession.serializer(), session.with("approval" to waiting))
        assertEquals("8d1e2f3a-4b5c-4d6e-9f70-a1b2c3d4e5f6", carrying.approval?.waitId)
        assertEquals("Send an email to dana@example.com: Lunch on Friday?", carrying.approval?.summary)
        // Computer Use: the phone may only deny.
        val denyOnly = roundTrip(AidenBotSession.serializer(), session.with("approval" to waiting.with("canAllow" to JsonPrimitive(false))))
        assertEquals(false, denyOnly.approval?.canAllow)

        // `approval` is required, even when nothing waits.
        rejects(AidenBotSession.serializer(), JsonObject(session - "approval"))
        // Exact keys; host bounds on every field.
        for (invalid in listOf(
            waiting.with("scopes" to JsonArray(listOf(JsonPrimitive("once")))),
            JsonObject(waiting - "canAllow"),
            waiting.with("canAllow" to JsonPrimitive("yes")),
            waiting.with("canAllow" to JsonPrimitive("true")),
            waiting.with("waitId" to JsonPrimitive("wait id")),
            waiting.with("waitId" to JsonPrimitive("wait_1")),
            waiting.with("waitId" to JsonPrimitive("a".repeat(65))),
            waiting.with("toolCallId" to JsonPrimitive("")),
            waiting.with("toolCallId" to JsonPrimitive("c".repeat(129))),
            waiting.with("toolName" to JsonPrimitive("t".repeat(121))),
            waiting.with("summary" to JsonPrimitive("")),
            waiting.with("summary" to JsonPrimitive("s".repeat(2_001)))
        )) {
            rejects(AidenBotSession.serializer(), session.with("approval" to invalid))
            rejects(AidenBotSessionEvent.serializer(), frame.with("payload" to JsonObject(mapOf("approval" to invalid))))
        }
        assertEquals(
            "s".repeat(2_000),
            json.decodeFromJsonElement(AidenBotSession.serializer(), session.with("approval" to waiting.with("summary" to JsonPrimitive("s".repeat(2_000))))).approval?.summary
        )
        // The frame's payload carries only `approval`.
        rejects(AidenBotSessionEvent.serializer(), frame.with("payload" to JsonObject(mapOf("approval" to waiting, "question" to kotlinx.serialization.json.JsonNull))))
        rejects(AidenBotSessionEvent.serializer(), frame.with("payload" to JsonObject(emptyMap())))
    }

    @Test
    fun failedTurnsDecodeWithAndWithoutRetryText() {
        val raw = fixture.getValue("botSessionFailedTurns").jsonArray
        val entry = AidenBotSessionEntry.serializer()
        val withText = roundTrip(entry, raw[0]) as AidenBotSessionEntry.FailedTurn
        assertEquals("entry_14:failed", withText.id)
        assertEquals("Plan my week, please.", withText.retryText)
        assertEquals(java.time.Instant.parse("2026-08-19T16:00:05Z"), withText.createdAt)
        // Only type and id: nothing to resend, and nothing is written back as null.
        val bare = roundTrip(entry, raw[1]) as AidenBotSessionEntry.FailedTurn
        assertEquals("entry_16:failed", bare.id)
        assertNull(bare.retryText)
        assertNull(bare.createdAt)
        assertEquals(setOf("type", "id"), json.encodeToJsonElement(entry, bare).jsonObject.keys)

        // A failed turn sits in the session alongside the older entry types.
        val session = fixture.getValue("botSession").jsonObject
        val decoded = json.decodeFromJsonElement(
            AidenBotSession.serializer(),
            session.with("entries" to JsonArray(session.getValue("entries").jsonArray + raw))
        )
        assertEquals(listOf(withText, bare), decoded.entries.takeLast(2))
        assertTrue(decoded.entries.any { it is AidenBotSessionEntry.Message })
        assertTrue(decoded.entries.any { it is AidenBotSessionEntry.ConnectCard })
        assertTrue(decoded.entries.any { it is AidenBotSessionEntry.Notice })

        val failed = raw[0].jsonObject
        rejects(entry, failed.with("retryText" to JsonPrimitive("")))
        rejects(entry, failed.with("retryText" to JsonPrimitive("x".repeat(AidenBotSessionWire.MAX_TEXT_LENGTH + 1))))
        rejects(entry, failed.with("errorMessage" to JsonPrimitive("Provider timed out")))
        rejects(entry, failed.with("id" to JsonPrimitive("entry 14")))
        rejects(entry, failed.with("createdAt" to JsonPrimitive("yesterday")))
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
