package sbtbiswas.AidenOnTheGo

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotSessionEventOutcome
import sbtbiswas.AidenOnTheGo.features.bots.aidenApplyBotSessionEvent
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenBotContractException
import sbtbiswas.AidenOnTheGo.protocol.AidenBotPrivateResponseScope
import sbtbiswas.AidenOnTheGo.protocol.AidenBotPrivateResponseValidator
import sbtbiswas.AidenOnTheGo.protocol.AidenRawJsonDuplicateKeyScanner
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException
import java.util.UUID

/**
 * Contract revision 42 (`bot:issues`): the "Needs you" cards, their frame, the act route and the
 * phone-feed item, read from the fixture every client shares.
 */
class AidenBotIssueContractTest {
    private val wire = AidenBotWireJson.json
    private val fixtureText: String by lazy {
        requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json")) { "contract.json" }
            .bufferedReader().use { it.readText() }
    }
    private val issues: JsonObject by lazy {
        Json.parseToJsonElement(fixtureText).jsonObject.getValue("botIssues").jsonObject
    }
    private val botID = "bot_fixture_01"
    private val routineID = "task_fixture_routine_01"

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

    private fun <T> decode(serializer: kotlinx.serialization.KSerializer<T>, element: Any): T =
        wire.decodeFromString(serializer, element.toString())

    private fun session(): AidenBotSession = decode(AidenBotSession.serializer(), issues.getValue("session"))

    private fun obj(element: kotlinx.serialization.json.JsonElement): JsonObject = element.jsonObject

    private fun JsonObject.with(vararg changes: Pair<String, kotlinx.serialization.json.JsonElement>): JsonObject =
        JsonObject(this + changes)

    @Test
    fun aHolderReadsTheCardsTheirFrameAndTheActRoute() {
        assertEquals(
            AidenRemoteCapability.BOT_ISSUES.rawValue,
            issues.getValue("capability").jsonPrimitive.content
        )
        // The whole fixture, the revision-42 root included, passes the shared guards.
        AidenRawJsonDuplicateKeyScanner.validate(fixtureText)
        AidenBotPrivateResponseValidator.validate(fixtureText, AidenBotPrivateResponseScope.SharedFixture)

        val session = session()
        assertEquals(
            listOf(
                "issue_fixture_preflight_01",
                "issue_fixture_routine_01",
                "issue_fixture_stall_01",
                "issue_fixture_fixed_01"
            ),
            session.issues?.map { it.id }
        )
        assertEquals(listOf(false, false, false, true), session.issues?.map { it.resolved })
        assertEquals(
            listOf(
                AidenBotIssueKind.PREFLIGHT_FAILED,
                AidenBotIssueKind.ROUTINE_PAUSED,
                AidenBotIssueKind.RUN_STALLED,
                AidenBotIssueKind.ROUTINE_FAILED
            ),
            session.issues?.map { it.kind }
        )
        // A card that only the Mac can answer keeps its title and body but no action.
        val noAction = requireNotNull(session.issues).first()
        assertEquals(emptyList<AidenBotIssueAction>(), noAction.actions)
        assertEquals("Gmail needs reconnecting", noAction.title)
        val routine = session.issues[1]
        assertEquals(routineID, routine.routineId)
        assertEquals(
            listOf(AidenBotIssueActionKind.OPEN_CHAT, AidenBotIssueActionKind.RESUME_ROUTINE),
            routine.actions.map { it.kind }
        )
        assertEquals(routineID, routine.actions.last().routineId)
        assertEquals(
            listOf(AidenBotIssueActionKind.STOP_RUN, AidenBotIssueActionKind.KEEP_WAITING),
            session.issues[2].actions.map { it.kind }
        )
        assertEquals(emptyList<AidenBotIssueAction>(), session.issues[3].actions)

        // The stream frame carries the same shapes, with one card settled.
        val frame = AidenBotSessionEventStream.decodeFrame(
            issues.getValue("events").jsonArray.first().toString().toByteArray(),
            botID
        )
        val shown = frame.payload
        assertTrue(shown is AidenBotSessionEventPayload.Issues)
        assertEquals(
            listOf(false, true, false),
            (shown as AidenBotSessionEventPayload.Issues).issues.map { it.resolved }
        )
        // Applying it replaces the card list, exactly as a live frame does.
        val applied = aidenApplyBotSessionEvent(session, frame)
        assertTrue(applied is AidenBotSessionEventOutcome.Applied)
        assertEquals(3, (applied as AidenBotSessionEventOutcome.Applied).session.issues?.size)

        val act = decode(AidenBotIssueActRequest.serializer(), issues.getValue("act").jsonObject.getValue("request"))
        assertEquals(AidenBotIssueActionKind.STOP_RUN, act.action.kind)
        assertNull(act.action.routineId)
        val receipt = decode(
            AidenBotIssueActReceipt.serializer(),
            issues.getValue("act").jsonObject.getValue("response")
        )
        assertEquals(AidenBotIssueActResult.DONE, receipt.result)
        assertEquals(
            AidenBotIssueActResult.NOT_OPEN,
            decode(AidenBotIssueActReceipt.serializer(), issues.getValue("notOpen")).result
        )

        // A summary says how many open decisions wait; the feed carries the card once.
        val summary = decode(AidenBotSummary.serializer(), issues.getValue("summary"))
        assertEquals(botID, summary.id)
        assertEquals(2, summary.issueCount)
        val feed = decode(AidenBotRoutineNotificationList.serializer(), issues.getValue("notification"))
        val card = feed.notifications.single()
        assertEquals(AidenBotNotificationKind.ISSUE, card.kind)
        assertEquals("Gmail needs reconnecting", card.routineName)
        assertNull(card.routineId)
        assertNull(card.status)
        assertTrue(card.isIssue)

        // Older hosts send no key: the session reads with no cards (null, not an empty list).
        val legacy = session().let {
            wire.decodeFromString(
                AidenBotSession.serializer(),
                JsonObject(obj(issues.getValue("session")) - "issues").toString()
            )
        }
        assertNull(legacy.issues)
        // A card this build cannot read fails closed rather than rendering wrongly.
        val rows = obj(issues.getValue("session")).getValue("issues").jsonArray
        val unknown = rows.toMutableList().also {
            it[0] = it[0].jsonObject.with("kind" to JsonPrimitive("surprise"))
        }
        assertThrows(kotlinx.serialization.SerializationException::class.java) {
            wire.decodeFromString(
                AidenBotSession.serializer(),
                obj(issues.getValue("session")).with(
                    "issues" to kotlinx.serialization.json.JsonArray(unknown)
                ).toString()
            )
        }
        // Settings never reach a phone.
        val withSettings = rows.toMutableList().also {
            it[0] = it[0].jsonObject.with(
                "actions" to kotlinx.serialization.json.JsonArray(
                    listOf(JsonObject(mapOf("kind" to JsonPrimitive("open_settings"))))
                )
            )
        }
        assertThrows(kotlinx.serialization.SerializationException::class.java) {
            wire.decodeFromString(
                AidenBotSession.serializer(),
                obj(issues.getValue("session")).with(
                    "issues" to kotlinx.serialization.json.JsonArray(withSettings)
                ).toString()
            )
        }
    }

    @Test
    fun aResumeTapPostsTheCardsActionToTheActRoute() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"result":"done"}"""))
        val action = AidenBotIssueAction(AidenBotIssueActionKind.RESUME_ROUTINE, routineID)
        val receipt = kotlinx.coroutines.runBlocking {
            client.actOnBotIssue(
                botId = botID,
                issueId = "issue_fixture_routine_01",
                request = AidenBotIssueActRequest(action),
                idempotencyKey = UUID.fromString("00000000-0000-4000-8000-000000000041")
            )
        }
        assertEquals(AidenBotIssueActResult.DONE, receipt.result)
        val recorded = server.takeRequest()
        assertEquals("POST", recorded.method)
        assertEquals(
            "/api/aiden/v1/bots/$botID/issues/issue_fixture_routine_01/act",
            recorded.path
        )
        val body = Json.parseToJsonElement(recorded.body.readUtf8()).jsonObject
        assertEquals(
            JsonObject(
                mapOf(
                    "action" to JsonObject(
                        mapOf(
                            "kind" to JsonPrimitive("resume_routine"),
                            "routineId" to JsonPrimitive(routineID)
                        )
                    )
                )
            ),
            body
        )
        assertEquals("00000000-0000-4000-8000-000000000041", recorded.getHeader("Idempotency-Key"))
    }

    @Test
    fun aMalformedReceiptAndAnUnknownActionFailClosed() {
        assertThrows(kotlinx.serialization.SerializationException::class.java) {
            wire.decodeFromString(AidenBotIssueActReceipt.serializer(), """{"result":"later"}""")
        }
        assertThrows(AidenBotContractException::class.java) {
            AidenBotIssueAction(AidenBotIssueActionKind.STOP_RUN, "routine_1")
        }
        assertThrows(AidenBotContractException::class.java) {
            AidenBotIssueAction(AidenBotIssueActionKind.KEEP_WAITING, null).let {
                // A settled card may not offer actions.
                AidenBotIssue(
                    id = "issue_1",
                    kind = AidenBotIssueKind.RUN_STALLED,
                    title = "Quiet",
                    body = "",
                    routineId = null,
                    actions = listOf(it),
                    createdAt = java.time.Instant.parse("2026-10-27T09:06:00Z"),
                    resolved = true
                )
            }
        }
    }
}
