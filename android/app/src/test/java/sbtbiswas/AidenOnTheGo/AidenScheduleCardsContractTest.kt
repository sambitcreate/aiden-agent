package sbtbiswas.AidenOnTheGo

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.features.remote.aidenProgressCapabilitiesToRequest
import sbtbiswas.AidenOnTheGo.features.remote.aidenRequestScheduleCards
import sbtbiswas.AidenOnTheGo.features.remote.aidenShouldRequestScheduleCards
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteRunApproval
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteRunEvent
import sbtbiswas.AidenOnTheGo.networking.AidenRunEventCodec
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import java.time.Instant
import java.time.ZoneId
import java.util.Collections
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Contract revision 38, `schedule:cards`: the scheduled-task card on approvals,
 * read from the fixture every client shares. A card the host would reject reads as no card and
 * never changes the approval around it.
 */
class AidenScheduleCardsContractTest {
    private val fixture: JsonObject by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json")) { "contract.json" }
            .bufferedReader().use { it.readText() }
        Json.parseToJsonElement(text).jsonObject
    }
    private val scheduleCards get() = fixture.getValue("scheduleCards").jsonObject
    private fun labelled(key: String): List<Pair<String, JsonObject>> = scheduleCards.getValue(key).jsonArray.map {
        val entry = it.jsonObject
        entry.getValue("label").jsonPrimitive.content to entry.getValue("schedule").jsonObject
    }
    private val cards get() = labelled("cards").toMap()
    private val rejected get() = labelled("rejected")
    private val runEvents get() = scheduleCards.getValue("phoneRunEvents").jsonArray.map { it.jsonObject }
    private val streamApproval get() = scheduleCards.getValue("streamApproval").jsonObject.getValue("approval").jsonObject

    private lateinit var server: MockWebServer
    private lateinit var client: AidenRemoteClient

    @Before
    fun setup() {
        server = MockWebServer()
        server.start()
        client = AidenRemoteClient(
            endpoint = server.url("/api/aiden/v1").toString().trimEnd('/'),
            credential = "test_credential_123",
            customOkHttpClient = OkHttpClient()
        )
    }

    @After
    fun teardown() {
        server.shutdown()
    }

    private fun JsonObject.with(vararg changes: Pair<String, JsonElement>): JsonObject = JsonObject(this + changes)
    private fun JsonObject.without(key: String): JsonObject = JsonObject(this - key)

    private fun decodeRun(event: JsonObject): AidenRemoteRunEvent = AidenRunEventCodec.decode(event.toString().toByteArray())

    /** The fixture's scheduled-task `approval_required` frame (sequence 2), with its payload changed. */
    private fun runApproval(change: (JsonObject) -> JsonObject): AidenRemoteRunApproval {
        val frame = runEvents.single { it.getValue("sequence").jsonPrimitive.content == "2" }
        val event = decodeRun(frame.with("payload" to change(frame.getValue("payload").jsonObject)))
        return (event.kind as AidenRemoteRunEvent.Kind.ApprovalRequired).approval
    }

    /** A run gap snapshot restating that approval, with its payload changed. */
    private fun snapshotApproval(change: (JsonObject) -> JsonObject): AidenRemoteRunApproval {
        val frame = runEvents.single { it.getValue("sequence").jsonPrimitive.content == "2" }
        val snapshot = frame.with(
            "sequence" to JsonPrimitive(2),
            "type" to JsonPrimitive("snapshot"),
            "payload" to JsonObject(mapOf(
                "runId" to frame.getValue("streamId"),
                "chatId" to JsonPrimitive("chat_fixture_01"),
                "reason" to JsonPrimitive("gap"),
                "nextSequence" to JsonPrimitive(3),
                "approvals" to JsonArray(listOf(change(frame.getValue("payload").jsonObject)))
            ))
        )
        return (decodeRun(snapshot).kind as AidenRemoteRunEvent.Kind.Snapshot).snapshot.approvals.single()
    }

    /** `GET /streams/{id}/approval` through the client, answering with [approval]. */
    private fun clientStreamApproval(approval: JsonObject): AidenStreamPendingApproval {
        server.enqueue(MockResponse().setResponseCode(200).setBody(JsonObject(mapOf("approval" to approval)).toString()))
        val read = runBlocking { client.streamApproval("stream_fixture_01") }
        assertEquals("/api/aiden/v1/streams/stream_fixture_01/approval", server.takeRequest().path)
        return requireNotNull(read.approval)
    }

    private val beforeExpiry = Instant.parse("2026-10-22T19:00:00Z")

    private fun resolved(approval: AidenStreamPendingApproval) = requireNotNull(
        AidenPendingApprovalResolution.resolve(approval, approval.streamId, approval.chatId, now = beforeExpiry)
    )

    @Test
    fun theFixtureIsAtRevision39AndNamesTheGrant() {
        assertTrue(fixture.getValue("contractRevision").jsonPrimitive.content.toInt() >= 38)
        assertEquals(AidenRemoteCapability.SCHEDULE_CARDS, AidenRemoteCapability(scheduleCards.getValue("capability").jsonPrimitive.content))
    }

    @Test
    fun everyFixtureCardReadsBackExactlyAsTheHostWroteIt() {
        assertEquals(
            setOf("create-read-only-project", "full-access-connectors", "scheduling-off", "paused-update", "truncated-prompt"),
            cards.keys
        )
        for ((label, wire) in cards) {
            val card = requireNotNull(AidenApprovalSchedule.parseOrNull(wire)) { label }
            assertEquals(label, wire, card.toJsonObject())
        }

        val project = AidenApprovalSchedule.parseOrNull(cards.getValue("create-read-only-project"))!!
        assertEquals(AidenApprovalScheduleAction.CREATE, project.action)
        assertEquals(AidenApprovalSchedulePermission.READ_ONLY, project.permission)
        assertEquals("Aiden Agent", project.workspaceName)
        assertEquals(Instant.parse("2026-10-23T16:00:00Z"), project.nextRun)

        val connectors = AidenApprovalSchedule.parseOrNull(cards.getValue("full-access-connectors"))!!
        assertEquals(AidenApprovalSchedulePermission.FULL, connectors.permission)
        assertTrue(connectors.connectors.isNotEmpty())

        val off = AidenApprovalSchedule.parseOrNull(cards.getValue("scheduling-off"))!!
        assertEquals(AidenApprovalScheduleMode.SCRIPT, off.mode)
        assertFalse(off.schedulerEnabled)
        assertNull(off.nextRun)
        assertNotNull(off.script)

        val paused = AidenApprovalSchedule.parseOrNull(cards.getValue("paused-update"))!!
        assertEquals(AidenApprovalScheduleAction.UPDATE, paused.action)
        assertFalse(paused.enabled)

        assertTrue(AidenApprovalSchedule.parseOrNull(cards.getValue("truncated-prompt"))!!.truncated)
    }

    @Test
    fun everyRejectedCardReadsAsNoCardAndLeavesTheApprovalAsTheHostSentIt() {
        assertEquals(12, rejected.size)
        for ((label, wire) in rejected) {
            assertNull(label, AidenApprovalSchedule.parseOrNull(wire))

            val run = runApproval { it.with("schedule" to wire) }
            assertNull("run $label", run.schedule)
            assertEquals("run $label", "approval_fixture_schedule_02", run.approvalId)
            assertTrue("run $label", run.canAllow)
            assertEquals("run $label", listOf(AidenApprovalScope.ONCE, AidenApprovalScope.CHAT), run.scopes)

            val gap = snapshotApproval { it.with("schedule" to wire) }
            assertNull("snapshot $label", gap.schedule)
            assertTrue("snapshot $label", gap.canAllow)
            assertEquals("snapshot $label", listOf(AidenApprovalScope.ONCE, AidenApprovalScope.CHAT), gap.scopes)

            val stream = clientStreamApproval(streamApproval.with("schedule" to wire))
            assertNull("stream $label", stream.schedule)
            assertTrue("stream $label", stream.canAllow)
            assertEquals("stream $label", listOf("once", "chat"), stream.scopes)
            val card = resolved(stream)
            assertNull("card $label", card.schedule)
            assertTrue("card $label", card.canAllow)
        }
    }

    @Test
    fun phoneRunEventsCarryACardOnlyOnTheScheduledTaskApproval() {
        val approvals = runEvents.map(::decodeRun).mapNotNull { (it.kind as? AidenRemoteRunEvent.Kind.ApprovalRequired)?.approval }
        assertEquals(listOf("schedule_task", "edit_automation"), approvals.map { it.toolName })

        val task = approvals[0]
        val card = requireNotNull(task.schedule)
        assertEquals("Inbox triage", card.name)
        assertEquals(AidenApprovalSchedulePermission.FULL, card.permission)
        assertEquals(listOf("Gmail", "Linear"), card.connectors)
        assertFalse(card.notify)
        assertTrue(task.canAllow)

        val automation = approvals[1]
        assertNull(automation.schedule)
        assertFalse(automation.canAllow)
        assertNull(automation.scopes)

        // The same card restated by a gap snapshot.
        assertEquals(card, snapshotApproval { it }.schedule)
    }

    @Test
    fun theStrictRunDecoderStillRefusesWhatItRefusedBefore() {
        // A malformed card is no card...
        for (malformed in listOf(JsonNull, JsonPrimitive("Morning briefing"), JsonPrimitive(1), JsonArray(emptyList()), JsonObject(emptyMap()))) {
            val approval = runApproval { it.with("schedule" to malformed) }
            assertNull(malformed.toString(), approval.schedule)
            assertTrue(approval.canAllow)
        }
        assertNull(runApproval { it.without("schedule") }.schedule)
        // ...but host previews and other unknown approval keys still fail the frame.
        for (key in listOf("details", "arguments", "scheduleCard")) {
            assertThrows(key, Exception::class.java) {
                runApproval { it.with(key to JsonObject(emptyMap())) }
            }
        }
    }

    @Test
    fun theStreamApprovalCarriesItsCardOntoTheScheduledTaskCardOnly() {
        val stream = clientStreamApproval(streamApproval)
        val expected = AidenApprovalSchedule.parseOrNull(streamApproval.getValue("schedule"))!!
        assertEquals(expected, stream.schedule)
        val card = resolved(stream)
        assertEquals(expected, card.schedule)
        assertTrue(card.canAllow)
        // Scheduled tasks are allowed once; the card adds no scope.
        assertEquals(listOf(AidenApprovalScope.ONCE), card.scopes)

        // Missing and malformed cards: the approval still decodes as it would have.
        assertNull(clientStreamApproval(streamApproval.without("schedule")).schedule)
        for (malformed in listOf(JsonNull, JsonPrimitive("x"), JsonPrimitive(true), JsonArray(emptyList()), JsonObject(emptyMap()))) {
            val read = clientStreamApproval(streamApproval.with("schedule" to malformed))
            assertNull(malformed.toString(), read.schedule)
            assertTrue(read.canAllow)
        }

        // A card on any other tool's approval is ignored by the card.
        val command = clientStreamApproval(streamApproval.with("toolName" to JsonPrimitive("run_command")))
        assertEquals(expected, command.schedule)
        assertNull(resolved(command).schedule)

        // Without schedule:write the phone can't allow, and the card doesn't change that.
        val readOnly = requireNotNull(
            AidenPendingApprovalResolution.resolve(
                stream, stream.streamId, stream.chatId,
                capabilities = AidenApprovalCapabilities(canRespond = true, canWriteSchedules = false),
                now = beforeExpiry
            )
        )
        assertEquals(expected, readOnly.schedule)
        assertFalse(readOnly.canAllow)
    }

    private val valid: JsonObject get() = cards.getValue("create-read-only-project")
    private fun reads(card: JsonObject) = AidenApprovalSchedule.parseOrNull(card) != null

    @Test
    fun textIsBoundedInJavaScriptUnitsAndMustBeSafeAndTrimmed() {
        assertTrue(reads(valid.with("name" to JsonPrimitive("a".repeat(120)))))
        assertFalse(reads(valid.with("name" to JsonPrimitive("a".repeat(121)))))
        // A character outside the BMP counts twice, as in JavaScript.
        val face = "😀"
        assertTrue(reads(valid.with("name" to JsonPrimitive(face.repeat(60)))))
        assertFalse(reads(valid.with("name" to JsonPrimitive(face.repeat(61)))))
        assertTrue(reads(valid.with("modelName" to JsonPrimitive("m".repeat(256)))))
        assertFalse(reads(valid.with("modelName" to JsonPrimitive("m".repeat(257)))))
        assertTrue(reads(valid.with("prompt" to JsonPrimitive("p".repeat(2_000)))))
        assertFalse(reads(valid.with("prompt" to JsonPrimitive("p".repeat(2_001)))))

        // Untrimmed, by JavaScript's whitespace, or empty.
        for (bad in listOf(" Morning", "Morning ", " Morning", "Morning﻿", "　Morning", "", "   ")) {
            assertFalse(bad, reads(valid.with("name" to JsonPrimitive(bad))))
        }
        // Control, line and bidi formatting characters.
        for (bad in listOf("Morning\tbriefing", "Morning\nbriefing", "Morning\u0085", "a؜b", "a‏b", "a‮b", "a⁦b", "a b")) {
            assertFalse(bad, reads(valid.with("name" to JsonPrimitive(bad))))
        }
        // Tabs and line breaks pass only in the instructions or script.
        assertTrue(reads(valid.with("prompt" to JsonPrimitive("Step one\n\tStep two\r\nDone"))))
        assertFalse(reads(valid.with("prompt" to JsonPrimitive("Step one Step two"))))
        assertFalse(reads(valid.with("prompt" to JsonPrimitive("Step one\u0007"))))
        // Non-strings.
        assertFalse(reads(valid.with("name" to JsonPrimitive(7))))
        assertFalse(reads(valid.with("providerName" to JsonNull)))
    }

    @Test
    fun theCardsShapeMatchesItsModeAndFlags() {
        assertTrue(reads(valid.without("nextRunAt")))
        assertTrue(reads(valid.with("nextRunAt" to JsonPrimitive("2026-10-23T16:00:00.123456789Z"))))
        for (bad in listOf("2026-10-23T16:00:00.1234567891Z", "2026-10-23T16:00Z", "2026-10-23 16:00:00Z", "2026-13-01T00:00:00Z", "2026-10-23T16:00:00+00:00")) {
            assertFalse(bad, reads(valid.with("nextRunAt" to JsonPrimitive(bad))))
        }

        assertTrue(reads(valid.with("connectors" to JsonArray(List(16) { JsonPrimitive("Connector $it") }))))
        assertFalse(reads(valid.with("connectors" to JsonArray(List(17) { JsonPrimitive("Connector $it") }))))
        assertFalse(reads(valid.without("connectors")))
        assertFalse(reads(valid.with("connectors" to JsonArray(listOf(JsonPrimitive(""))))))

        for (flag in listOf("notify", "enabled", "schedulerEnabled")) {
            assertFalse(flag, reads(valid.without(flag)))
            assertFalse(flag, reads(valid.with(flag to JsonPrimitive("true"))))
            assertFalse(flag, reads(valid.with(flag to JsonPrimitive(1))))
        }
        assertFalse(reads(valid.with("action" to JsonPrimitive("delete"))))
        assertFalse(reads(valid.with("mode" to JsonPrimitive("agent"))))
        assertFalse(reads(valid.with("permission" to JsonPrimitive("write"))))

        // A script carries no prompt or model; instructions carry no script.
        val script = valid.without("prompt").without("providerName").without("modelName")
            .with("mode" to JsonPrimitive("script"), "script" to JsonPrimitive("git fetch --all"))
        assertTrue(reads(script))
        assertFalse(reads(script.with("modelName" to JsonPrimitive("Model"))))
        assertFalse(reads(script.with("prompt" to JsonPrimitive("Summarize"))))
        assertFalse(reads(valid.with("script" to JsonPrimitive("git fetch --all"))))

        // `truncated` is literal true, and only beside the text it describes.
        assertTrue(AidenApprovalSchedule.parseOrNull(valid.with("truncated" to JsonPrimitive(true)))!!.truncated)
        assertFalse(AidenApprovalSchedule.parseOrNull(valid)!!.truncated)
        assertFalse(reads(valid.with("truncated" to JsonPrimitive("true"))))
        assertFalse(reads(valid.without("prompt").with("truncated" to JsonPrimitive(true))))
    }

    private fun card(change: (JsonObject) -> JsonObject = { it }) = AidenApprovalSchedule.parseOrNull(change(valid))!!

    @Test
    fun theCardsWordingFollowsWhatApprovingWouldDo() {
        val titles = mapOf(
            "create" to "Save this scheduled task?",
            "update" to "Update this scheduled task?",
            "pause" to "Pause this scheduled task?",
            "resume" to "Resume this scheduled task?",
            "remove" to "Delete this scheduled task?",
            "run_now" to "Run this scheduled task now?"
        )
        for ((wire, title) in titles) {
            assertEquals(wire, title, AidenApprovalSchedulePresentation.title(card { it.with("action" to JsonPrimitive(wire)) }.action))
        }

        // Runs in: the project, else the connectors, else anywhere with full access, else no project.
        val connectors = JsonArray(listOf(JsonPrimitive("Gmail"), JsonPrimitive("Linear")))
        assertEquals(AidenApprovalScheduleLocation.Project("Aiden Agent"), AidenApprovalSchedulePresentation.location(card { it.with("connectors" to connectors) }))
        val noProject = valid.without("workspaceName")
        assertEquals(
            AidenApprovalScheduleLocation.Connectors(listOf("Gmail", "Linear")),
            AidenApprovalSchedulePresentation.location(card { noProject.with("connectors" to connectors) })
        )
        assertEquals(AidenApprovalScheduleLocation.Anywhere, AidenApprovalSchedulePresentation.location(card { noProject.with("permission" to JsonPrimitive("full")) }))
        assertEquals(AidenApprovalScheduleLocation.NoProject, AidenApprovalSchedulePresentation.location(card { noProject }))

        // Model: whichever parts the host sent; a script has none.
        assertEquals("OpenRouter · Qwen3 Coder", AidenApprovalSchedulePresentation.model(card()))
        assertEquals("OpenRouter", AidenApprovalSchedulePresentation.model(card { it.without("modelName") }))
        assertEquals("Qwen3 Coder", AidenApprovalSchedulePresentation.model(card { it.without("providerName") }))
        assertNull(AidenApprovalSchedulePresentation.model(card { it.without("providerName").without("modelName") }))
        val script = AidenApprovalSchedule.parseOrNull(cards.getValue("scheduling-off"))!!
        assertNull(AidenApprovalSchedulePresentation.model(script))
        assertEquals(script.script, AidenApprovalSchedulePresentation.body(script))
        assertEquals(card().prompt, AidenApprovalSchedulePresentation.body(card()))
    }

    @Test
    fun theNextRunAndNotesShowOnlyWhenTheyAreTrue() {
        val next = Instant.parse("2026-10-23T16:00:00Z")
        assertEquals(next, AidenApprovalSchedulePresentation.nextRun(card()))
        assertNull(AidenApprovalSchedulePresentation.nextRun(card { it.without("nextRunAt") }))
        assertNull("paused", AidenApprovalSchedulePresentation.nextRun(card { it.with("enabled" to JsonPrimitive(false)) }))
        assertNull("scheduling off", AidenApprovalSchedulePresentation.nextRun(card { it.with("schedulerEnabled" to JsonPrimitive(false)) }))
        assertNull("deleted", AidenApprovalSchedulePresentation.nextRun(card { it.with("action" to JsonPrimitive("remove")) }))
        // The task as it will be once approved: resuming a paused task brings its next run back, pausing removes it.
        assertEquals(
            "resumed",
            next,
            AidenApprovalSchedulePresentation.nextRun(card { it.with("action" to JsonPrimitive("resume"), "enabled" to JsonPrimitive(false)) })
        )
        assertNull("paused by this approval", AidenApprovalSchedulePresentation.nextRun(card { it.with("action" to JsonPrimitive("pause")) }))

        assertNull(AidenApprovalSchedulePresentation.note(card()))
        assertEquals(
            AidenApprovalScheduleNote.SCHEDULING_OFF,
            AidenApprovalSchedulePresentation.note(AidenApprovalSchedule.parseOrNull(cards.getValue("scheduling-off"))!!)
        )
        assertEquals(
            AidenApprovalScheduleNote.SCHEDULING_OFF,
            AidenApprovalSchedulePresentation.note(card { it.with("schedulerEnabled" to JsonPrimitive(false), "enabled" to JsonPrimitive(false)) })
        )
        assertEquals(
            AidenApprovalScheduleNote.STAYS_PAUSED,
            AidenApprovalSchedulePresentation.note(AidenApprovalSchedule.parseOrNull(cards.getValue("paused-update"))!!)
        )
        assertNull(
            "a deleted task is not paused",
            AidenApprovalSchedulePresentation.note(card { it.with("enabled" to JsonPrimitive(false), "action" to JsonPrimitive("remove")) })
        )
        // The Mac sends a card's state once approved: a pause arrives disabled and says so in its question.
        assertNull(
            "a pause is not 'stays paused'",
            AidenApprovalSchedulePresentation.note(card { it.with("enabled" to JsonPrimitive(false), "action" to JsonPrimitive("pause")) })
        )
        assertNull(
            "a resumed task is not 'stays paused'",
            AidenApprovalSchedulePresentation.note(card { it.with("enabled" to JsonPrimitive(false), "action" to JsonPrimitive("resume")) })
        )
        assertEquals(
            "running it once leaves it paused",
            AidenApprovalScheduleNote.STAYS_PAUSED,
            AidenApprovalSchedulePresentation.note(card { it.with("enabled" to JsonPrimitive(false), "action" to JsonPrimitive("run_now")) })
        )
    }

    @Test
    fun theNextRunReadsInTheDevicesTime() {
        val now = Instant.parse("2026-10-22T19:10:00Z") // Thursday, 12:10 in Los Angeles.
        val pacific = ZoneId.of("America/Los_Angeles")
        fun text(at: String, zone: ZoneId = pacific, use24Hour: Boolean = false) =
            AidenApprovalSchedulePresentation.nextRunText(Instant.parse(at), now, zone, Locale.US, use24Hour)

        assertEquals("today at 3:00 PM", text("2026-10-22T22:00:00Z"))
        assertEquals("tomorrow at 9:00 AM", text("2026-10-23T16:00:00Z"))
        assertEquals("tomorrow at 9:00", text("2026-10-23T16:00:00Z", use24Hour = true))
        assertEquals("Sat, Oct 24 at 9:00 AM", text("2026-10-24T16:00:00Z"))
        // The same instant on a phone in London: still tomorrow, at its own hour.
        assertEquals("tomorrow at 5:00 PM", text("2026-10-23T16:00:00Z", zone = ZoneId.of("Europe/London")))
        // Past local midnight in Tokyo, 9 AM Pacific on the 23rd is already the 24th.
        assertEquals("tomorrow at 1:00 AM", text("2026-10-23T16:00:00Z", zone = ZoneId.of("Asia/Tokyo")))
    }

    // Negotiation.

    private fun mac(capabilities: List<AidenRemoteCapability>, offers: List<AidenRemoteCapability>) = AidenServer(
        instanceId = "test_instance",
        name = "Mac",
        capabilities = capabilities,
        serverCapabilities = (capabilities + offers).distinct()
    )

    private fun installationHolding(held: List<AidenRemoteCapability>) = AidenInstallation(
        instanceId = "test_instance",
        deviceId = "test_device",
        name = "Mac",
        endpoint = "https://aiden.test/api/aiden/v1",
        serverSpkiSha256 = "sha256/test",
        deviceCapabilities = held,
        serverCapabilities = held,
        createdAt = Instant.parse("2026-10-20T09:00:00Z")
    )

    private val base = listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.SCHEDULE_READ, AidenRemoteCapability.SCHEDULE_WRITE)

    private fun serverBody(capabilities: List<String>, serverCapabilities: List<String>) = """
        {"protocolVersion":1,"instanceId":"test_instance","name":"Mac","appVersion":"1.0.0","connectionMode":"lan",
         "serverTime":"2026-10-22T09:00:00.000Z",
         "capabilities":${JsonArray(capabilities.map(::JsonPrimitive))},
         "serverCapabilities":${JsonArray(serverCapabilities.map(::JsonPrimitive))}}
    """.trimIndent()

    private fun refusal(status: Int) = MockResponse().setResponseCode(status).setBody(
        """{"error":{"code":"${if (status == 400) "invalid_request" else "not_found"}","message":"Nope.","requestId":"req_1","retryable":false}}"""
    )

    @Test
    fun theGrantIsAskedForOnlyFromAMacThatOffersItAndNeverWithTheProgressGrants() {
        val offering = mac(base, offers = listOf(AidenRemoteCapability.SCHEDULE_CARDS, AidenRemoteCapability.BOT_ACTIVITY))
        assertTrue(offering.offersScheduleCards)
        assertFalse("offered is not held", offering.supportsScheduleCards)
        assertTrue(aidenShouldRequestScheduleCards(offering, installationHolding(base)))
        assertFalse(aidenProgressCapabilitiesToRequest(offering, installationHolding(base)).contains(AidenRemoteCapability.SCHEDULE_CARDS))

        assertFalse("not offered", aidenShouldRequestScheduleCards(mac(base, emptyList()), installationHolding(base)))
        val held = base + AidenRemoteCapability.SCHEDULE_CARDS
        val holding = mac(held, emptyList())
        assertTrue(holding.supportsScheduleCards)
        assertFalse("already held", aidenShouldRequestScheduleCards(holding, installationHolding(held)))
    }

    @Test
    fun theGrantGoesInACallOfItsOwnAndARefusalLeavesThePairingAsItWas() = runBlocking {
        val names = base.map { it.rawValue }
        val offering = mac(base, offers = listOf(AidenRemoteCapability.SCHEDULE_CARDS))

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"capabilities":${JsonArray((names + "schedule:cards").map(::JsonPrimitive))}}"""))
        server.enqueue(MockResponse().setResponseCode(200).setBody(serverBody(names + "schedule:cards", names + "schedule:cards")))
        val granted = requireNotNull(aidenRequestScheduleCards(client, offering, installationHolding(base)))
        val ask = server.takeRequest()
        assertEquals("/api/aiden/v1/device/capabilities", ask.path)
        assertEquals(
            listOf("schedule:cards"),
            Json.parseToJsonElement(ask.body.readUtf8()).jsonObject.getValue("accepts").jsonArray.map { it.jsonPrimitive.content }
        )
        assertEquals("/api/aiden/v1/server", server.takeRequest().path)
        assertEquals(base + AidenRemoteCapability.SCHEDULE_CARDS, granted.granted)
        assertTrue(granted.server.supportsScheduleCards)

        for (status in listOf(400, 404)) {
            server.enqueue(refusal(status))
            assertNull(aidenRequestScheduleCards(client, offering, installationHolding(base)))
            assertEquals("/api/aiden/v1/device/capabilities", server.takeRequest().path)
        }
        assertEquals("a refusal reads nothing more", 4, server.requestCount)

        server.enqueue(MockResponse().setResponseCode(401).setBody(
            """{"error":{"code":"credential_revoked","message":"Nope.","requestId":"req_1","retryable":false}}"""
        ))
        assertThrows(AidenRemoteClientException.Server::class.java) {
            runBlocking { aidenRequestScheduleCards(client, offering, installationHolding(base)) }
        }

        val before = server.requestCount
        assertNull(aidenRequestScheduleCards(client, mac(base, emptyList()), installationHolding(base)))
        assertEquals(before, server.requestCount)
    }

    @Test
    fun connectingAsksForEachSoloGrantAloneWithScheduleCardsLastAndARefusalKeepsTheOthers() = runBlocking {
        val names = base.map { it.rawValue }
        val offered = names + "bot:handoffs" + "schedule:cards"
        val held = Collections.synchronizedList(names.toMutableList())
        val asks = Collections.synchronizedList(mutableListOf<List<String>>())
        val refuseCards = AtomicBoolean(true)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl!!.encodedPath) {
                "/api/aiden/v1/server" -> MockResponse().setResponseCode(200).setBody(serverBody(held.toList(), offered))
                "/api/aiden/v1/device/capabilities" -> {
                    val accepts = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
                        .getValue("accepts").jsonArray.map { it.jsonPrimitive.content }
                    asks += accepts
                    if (accepts == listOf("schedule:cards") && refuseCards.get()) {
                        refusal(400)
                    } else {
                        held += accepts.filterNot(held::contains)
                        MockResponse().setResponseCode(200)
                            .setBody("""{"capabilities":${JsonArray(held.toList().map(::JsonPrimitive))}}""")
                    }
                }
                else -> MockResponse().setResponseCode(404)
            }
        }
        val root = kotlin.io.path.createTempDirectory("aiden-schedule-cards").toFile()
        val job = SupervisorJob()
        try {
            val installations = AidenInstallationStore(root, InMemoryAidenSecureStore())
            installations.addInstallation(
                AidenPairingExchange(
                    instanceId = "test_instance",
                    deviceId = "test_device",
                    endpoint = server.url("/api/aiden/v1").toString(),
                    serverSpkiSha256 = "sha256/test",
                    credential = "synthetic",
                    capabilities = base
                ),
                null
            )
            val coordinator = AidenRemoteCoordinator(installations, root, scope = CoroutineScope(Dispatchers.IO + job))
            val first = requireNotNull(withTimeout(5_000) { coordinator.serverInfo.first { it != null } })
            assertEquals(listOf(listOf("bot:handoffs"), listOf("schedule:cards")), asks.toList())
            // The Mac refused the card, and the hand-off grant asked for before it stays.
            assertTrue(first.supportsBotHandoffs)
            assertFalse(first.supportsScheduleCards)
            val afterRefusal = requireNotNull(installations.activeInstallation)
            assertTrue(afterRefusal.hasNegotiatedAccess(AidenRemoteCapability.BOT_HANDOFFS))
            assertFalse(afterRefusal.hasNegotiatedAccess(AidenRemoteCapability.SCHEDULE_CARDS))
            assertTrue(afterRefusal.hasNegotiatedAccess(AidenRemoteCapability.SCHEDULE_READ))

            // A Mac that grants it on the next connection: only the card is asked for, alone.
            refuseCards.set(false)
            asks.clear()
            coordinator.refreshClient()
            val second = requireNotNull(withTimeout(5_000) { coordinator.serverInfo.first { it?.supportsScheduleCards == true } })
            assertEquals(listOf(listOf("schedule:cards")), asks.toList())
            assertTrue(second.supportsBotHandoffs)
            assertTrue(requireNotNull(installations.activeInstallation).hasNegotiatedAccess(AidenRemoteCapability.SCHEDULE_CARDS))
        } finally {
            job.cancel()
            root.deleteRecursively()
        }
    }
}
