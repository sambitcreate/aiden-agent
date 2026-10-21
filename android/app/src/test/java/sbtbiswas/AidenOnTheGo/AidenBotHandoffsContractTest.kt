package sbtbiswas.AidenOnTheGo

import kotlinx.coroutines.runBlocking
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
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotSessionEventOutcome
import sbtbiswas.AidenOnTheGo.features.bots.aidenApplyBotSessionEvent
import sbtbiswas.AidenOnTheGo.features.remote.aidenProgressCapabilitiesToRequest
import sbtbiswas.AidenOnTheGo.features.remote.aidenRequestBotHandoffs
import sbtbiswas.AidenOnTheGo.features.remote.aidenShouldRequestBotHandoffs
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenBotPrivateResponseScope
import sbtbiswas.AidenOnTheGo.protocol.AidenBotPrivateResponseValidator
import sbtbiswas.AidenOnTheGo.protocol.AidenRawJsonDuplicateKeyScanner
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorEnvelope
import java.time.Instant
import java.util.UUID

/** Contract revision 37 (`bot:handoffs`): hand-offs and pause, read from the fixture every client shares. */
class AidenBotHandoffsContractTest {
    private val wire = AidenBotWireJson.json
    private val fixtureText: String by lazy {
        requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json")) { "contract.json" }
            .bufferedReader().use { it.readText() }
    }
    private val handoffs: JsonObject by lazy {
        Json.parseToJsonElement(fixtureText).jsonObject.getValue("botHandoffs").jsonObject
    }
    private val legacy get() = handoffs.getValue("legacy").jsonObject
    private val waitId = "4f9c2d1e-7a3b-4c5d-9e8f-0a1b2c3d4e5f"

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

    /** What the client does with a body: the privacy guard for its route, then the strict decode. */
    private fun <T> asClientReads(root: String, serializer: kotlinx.serialization.KSerializer<T>, element: JsonElement): T {
        AidenBotPrivateResponseValidator.validate(element.toString(), AidenBotPrivateResponseScope.Root(root))
        return wire.decodeFromString(serializer, element.toString())
    }

    private fun frame(element: JsonElement): AidenBotSessionEvent =
        AidenBotSessionEventStream.decodeFrame(element.toString().toByteArray(), "bot_fixture_01")

    private fun JsonObject.with(vararg changes: Pair<String, JsonElement>): JsonObject = JsonObject(this + changes)
    private fun JsonObject.without(key: String): JsonObject = JsonObject(this - key)

    private fun errorCode(element: JsonElement): AidenRemoteErrorCode =
        Json.decodeFromString(AidenRemoteErrorEnvelope.serializer(), element.toString()).error.code

    @Test
    fun aHolderReadsTheHandoffItsFramesAndThePausedBot() {
        assertEquals(AidenRemoteCapability.BOT_HANDOFFS.rawValue, handoffs.getValue("capability").jsonPrimitive.content)
        // The whole fixture, the revision-37 root and its paused detail's instructions included, passes the shared guard.
        AidenRawJsonDuplicateKeyScanner.validate(fixtureText)
        AidenBotPrivateResponseValidator.validate(fixtureText, AidenBotPrivateResponseScope.SharedFixture)

        val session = asClientReads("botSession", AidenBotSession.serializer(), handoffs.getValue("session"))
        assertEquals(
            AidenBotHandoff(
                waitId = waitId,
                kind = AidenBotHandoffKind.ACTION,
                action = "Enter the 2FA code your bank sent you",
                why = "The bank asks for a code only you can see.",
                openUrl = "https://bank.example.com/verify"
            ),
            session.handoff
        )

        // The frames, applied in order, end exactly where the fixture's paused session stands.
        val events = handoffs.getValue("events").jsonArray.map(::frame)
        assertEquals(listOf("handoff", "handoff", "entry", "state"), events.map { it.type })
        assertEquals(session.handoff, (events[0].payload as AidenBotSessionEventPayload.Handoff).handoff)
        assertNull((events[1].payload as AidenBotSessionEventPayload.Handoff).handoff)
        var current = session
        for (event in events) {
            current = (aidenApplyBotSessionEvent(current, event) as AidenBotSessionEventOutcome.Applied).session
        }
        val paused = asClientReads("botSession", AidenBotSession.serializer(), handoffs.getValue("pausedSession"))
        assertEquals(paused, current)
        assertEquals(AidenBotSessionState.PAUSED, paused.state)
        assertFalse(paused.interrupted)
        // The person's answer reaches every device as their own message.
        val answer = paused.entries.last() as AidenBotSessionEntry.Message
        assertEquals("entry_handoff:call_fixture_36", answer.id)
        assertEquals(AidenBotMessageRole.USER, answer.role)

        // Bot rows carry the flag beside the paused state.
        val summary = asClientReads("botSummary", AidenBotSummary.serializer(), handoffs.getValue("pausedSummary"))
        assertTrue(summary.paused)
        assertEquals(AidenBotSessionState.PAUSED, summary.sessionState)
        val detail = asClientReads("botDetail", AidenBotDetail.serializer(), handoffs.getValue("pausedDetail"))
        assertTrue(detail.paused)
        assertEquals(AidenBotSessionState.PAUSED, detail.sessionState)
        assertEquals(AidenRemoteErrorCode.BOT_PAUSED, errorCode(handoffs.getValue("pausedError")))
    }

    @Test
    fun anOlderPhoneSeesANoticeAnUnavailableBotAndAStaleWrite() {
        val session = asClientReads("botSession", AidenBotSession.serializer(), legacy.getValue("session"))
        assertNull(session.handoff)
        val notice = session.entries.last() as AidenBotSessionEntry.Message
        assertEquals("handoff-notice:$waitId", notice.id)
        assertEquals(AidenBotMessageRole.ASSISTANT, notice.role)
        assertNull(notice.createdAt)

        var current = session
        for (event in legacy.getValue("events").jsonArray.map(::frame)) {
            assertFalse("an older phone is never sent a hand-off frame", event.payload is AidenBotSessionEventPayload.Handoff)
            current = (aidenApplyBotSessionEvent(current, event) as AidenBotSessionEventOutcome.Applied).session
        }
        val paused = asClientReads("botSession", AidenBotSession.serializer(), legacy.getValue("pausedSession"))
        assertEquals(AidenBotSessionState.UNAVAILABLE, paused.state)
        assertEquals(paused.entries.map { it.id }, current.entries.map { it.id }.filterNot { it.startsWith("handoff-notice:") })

        val summary = asClientReads("botSummary", AidenBotSummary.serializer(), legacy.getValue("pausedSummary"))
        assertFalse(summary.paused)
        assertEquals(AidenBotSessionState.UNAVAILABLE, summary.sessionState)
        assertEquals(AidenRemoteErrorCode.OPERATION_STALE, errorCode(legacy.getValue("pausedError")))
    }

    @Test
    fun handoffShapesFailClosedLikeTheMacsParsers() {
        val session = handoffs.getValue("session").jsonObject
        val handoff = session.getValue("handoff").jsonObject
        val open = handoff.getValue("open").jsonObject
        fun refuses(changed: JsonObject) = assertThrows(Exception::class.java) {
            wire.decodeFromString(AidenBotSession.serializer(), session.with("handoff" to changed).toString())
        }
        refuses(handoff.with("tool" to JsonPrimitive("browser")))
        refuses(handoff.with("kind" to JsonPrimitive("maybe")))
        refuses(handoff.with("waitId" to JsonPrimitive("wait/1")))
        refuses(handoff.with("action" to JsonPrimitive("   ")))
        refuses(handoff.with("action" to JsonPrimitive("a".repeat(AidenBotHandoffWire.MAX_ACTION_LENGTH + 1))))
        refuses(handoff.with("why" to JsonNull))
        refuses(handoff.with("why" to JsonPrimitive("w".repeat(AidenBotHandoffWire.MAX_WHY_LENGTH + 1))))
        refuses(handoff.without("action"))
        refuses(handoff.with("open" to open.with("label" to JsonPrimitive("Bank"))))
        for (url in listOf(
            "http://bank.example.com/verify",
            "https://user:secret@bank.example.com/verify",
            " https://bank.example.com/verify",
            "javascript:alert(1)",
            "https://",
            "https://bank.example.com:99999/verify"
        )) {
            refuses(handoff.with("open" to JsonObject(mapOf("url" to JsonPrimitive(url)))))
        }
        // Both optional fields may be left out.
        val bare = wire.decodeFromString(AidenBotSession.serializer(), session.with("handoff" to handoff.without("why").without("open")).toString())
        assertEquals(AidenBotHandoff(waitId, AidenBotHandoffKind.ACTION, "Enter the 2FA code your bank sent you"), bare.handoff)

        // A frame carries exactly `handoff`.
        val event = handoffs.getValue("events").jsonArray[0].jsonObject
        val payload = event.getValue("payload").jsonObject
        assertThrows(Exception::class.java) { frame(event.with("payload" to payload.with("extra" to JsonPrimitive(1)))) }
        assertThrows(Exception::class.java) { frame(event.with("payload" to JsonObject(emptyMap()))) }

        // The flag and the paused state always agree.
        val summary = handoffs.getValue("pausedSummary").jsonObject
        assertThrows(Exception::class.java) {
            wire.decodeFromString(AidenBotSummary.serializer(), summary.with("sessionState" to JsonPrimitive("idle")).toString())
        }
        assertThrows(Exception::class.java) { wire.decodeFromString(AidenBotSummary.serializer(), summary.without("paused").toString()) }
        assertThrows(Exception::class.java) {
            wire.decodeFromString(AidenBotSummary.serializer(), summary.with("paused" to JsonPrimitive("true")).toString())
        }
        val detail = handoffs.getValue("pausedDetail").jsonObject
        assertThrows(Exception::class.java) {
            wire.decodeFromString(AidenBotDetail.serializer(), detail.with("paused" to JsonPrimitive(false)).toString())
        }

        // An answer's note is never blank and at most 4,000 characters.
        assertThrows(Exception::class.java) { AidenBotHandoffAnswerRequest(AidenBotHandoffOutcome.DONE, " \n ") }
        assertThrows(Exception::class.java) {
            AidenBotHandoffAnswerRequest(AidenBotHandoffOutcome.DONE, "n".repeat(AidenBotHandoffWire.MAX_NOTE_LENGTH + 1))
        }
    }

    @Test
    fun anOpenPageIsAnHttpsPageWithAHostAndNoUserName() {
        for (url in listOf(
            "https://bank.example.com/verify",
            "HTTPS://bank.example.com",
            "https://bank.example.com:8443/verify?step=2#code",
            "https://[2001:db8::1]/sign-in",
            // The Mac stores a page as its WHATWG href, which keeps `[`, `]` and `|` unescaped.
            "https://jira.example.com/browse?filter[status]=open&q=a|b"
        )) assertTrue(url, AidenBotHandoffWire.isOpenUrl(url))
        for (url in listOf(
            "",
            "http://bank.example.com",
            "https://",
            "https:///bank.example.com",
            "https://:443/",
            "https://@bank.example.com/",
            "https://bank example.com/",
            "https://bank.example.com/\n",
            "https://bank.example.com:port/",
            "https://" + "a".repeat(AidenBotHandoffWire.MAX_URL_LENGTH)
        )) assertFalse(url, AidenBotHandoffWire.isOpenUrl(url))
    }

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

    private val base = listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.BOT_READ, AidenRemoteCapability.BOT_WRITE)

    @Test
    fun theGrantIsAskedForOnlyFromAMacThatOffersItAndNeverWithTheProgressGrants() {
        val offering = mac(base, offers = listOf(AidenRemoteCapability.BOT_HANDOFFS, AidenRemoteCapability.BOT_ACTIVITY))
        assertTrue(offering.offersBotHandoffs)
        assertFalse("offered is not held", offering.supportsBotHandoffs)
        assertTrue(aidenShouldRequestBotHandoffs(offering, installationHolding(base)))
        // The progress batch asks for bot:activity but never bot:handoffs: an older Mac refuses a batch naming it.
        val progress = aidenProgressCapabilitiesToRequest(offering, installationHolding(base))
        assertTrue(progress.contains(AidenRemoteCapability.BOT_ACTIVITY))
        assertFalse(progress.contains(AidenRemoteCapability.BOT_HANDOFFS))

        assertFalse("not offered", aidenShouldRequestBotHandoffs(mac(base, emptyList()), installationHolding(base)))
        val held = base + AidenRemoteCapability.BOT_HANDOFFS
        val holding = mac(held, emptyList())
        assertTrue(holding.supportsBotHandoffs)
        assertFalse("already held", aidenShouldRequestBotHandoffs(holding, installationHolding(held)))
    }

    private fun serverBody(capabilities: List<String>, serverCapabilities: List<String>) = """
        {"protocolVersion":1,"instanceId":"test_instance","name":"Mac","appVersion":"1.0.0","connectionMode":"lan",
         "serverTime":"2026-10-20T09:00:00.000Z",
         "capabilities":${JsonArray(capabilities.map(::JsonPrimitive))},
         "serverCapabilities":${JsonArray(serverCapabilities.map(::JsonPrimitive))}}
    """.trimIndent()

    @Test
    fun theGrantGoesInACallOfItsOwnAndARefusalLeavesThePairingAsItWas() = runBlocking {
        val names = base.map { it.rawValue }
        val offering = mac(base, offers = listOf(AidenRemoteCapability.BOT_HANDOFFS))

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"capabilities":${JsonArray((names + "bot:handoffs").map(::JsonPrimitive))}}"""))
        server.enqueue(MockResponse().setResponseCode(200).setBody(serverBody(names + "bot:handoffs", names + "bot:handoffs")))
        val granted = requireNotNull(aidenRequestBotHandoffs(client, offering, installationHolding(base)))
        val ask = server.takeRequest()
        assertEquals("/api/aiden/v1/device/capabilities", ask.path)
        assertEquals(
            listOf("bot:handoffs"),
            Json.parseToJsonElement(ask.body.readUtf8()).jsonObject.getValue("accepts").jsonArray.map { it.jsonPrimitive.content }
        )
        assertEquals("/api/aiden/v1/server", server.takeRequest().path)
        assertEquals(base + AidenRemoteCapability.BOT_HANDOFFS, granted.granted)
        assertTrue(granted.server.supportsBotHandoffs)

        // A Mac that refuses the name (400) or the route (404): nothing is kept, and nothing else is asked.
        for (status in listOf(400, 404)) {
            server.enqueue(MockResponse().setResponseCode(status).setBody(
                """{"error":{"code":"${if (status == 400) "invalid_request" else "not_found"}","message":"Nope.","requestId":"req_1","retryable":false}}"""
            ))
            assertNull(aidenRequestBotHandoffs(client, offering, installationHolding(base)))
            assertEquals("/api/aiden/v1/device/capabilities", server.takeRequest().path)
        }
        assertEquals("a refusal reads nothing more", 4, server.requestCount)

        // A revoked credential still ends the pairing.
        server.enqueue(MockResponse().setResponseCode(401).setBody(
            """{"error":{"code":"credential_revoked","message":"Nope.","requestId":"req_1","retryable":false}}"""
        ))
        assertThrows(AidenRemoteClientException.Server::class.java) {
            runBlocking { aidenRequestBotHandoffs(client, offering, installationHolding(base)) }
        }

        // A Mac that never offers it is never asked.
        val before = server.requestCount
        assertNull(aidenRequestBotHandoffs(client, mac(base, emptyList()), installationHolding(base)))
        assertEquals(before, server.requestCount)
    }

    @Test
    fun answersOpenOnMacPauseAndResumeUseTheirOwnRoutesBodiesAndKeys() = runBlocking {
        val answer = handoffs.getValue("answer").jsonObject
        val openOnMac = handoffs.getValue("openOnMac").jsonObject
        fun ok(body: JsonElement) = MockResponse().setResponseCode(200).setBody(body.toString())
        server.enqueue(ok(answer.getValue("response")))
        server.enqueue(ok(openOnMac.getValue("response")))
        server.enqueue(ok(handoffs.getValue("pause").jsonObject.getValue("response")))
        server.enqueue(ok(handoffs.getValue("unpause").jsonObject.getValue("response")))

        val keys = List(4) { UUID.randomUUID() }
        val request = AidenBotHandoffAnswerRequest(AidenBotHandoffOutcome.DONE, "The code was from 9:01.")
        assertEquals(waitId, client.answerBotHandoff("bot_fixture_01", waitId, request, keys[0]).waitId)
        assertTrue(client.openBotHandoffOnMac("bot_fixture_01", waitId, keys[1]).opened)
        assertEquals(AidenBotSessionState.PAUSED, client.pauseBot("bot_fixture_01", keys[2]).state)
        assertEquals(AidenBotSessionState.IDLE, client.unpauseBot("bot_fixture_01", keys[3]).state)

        val sent = List(4) { server.takeRequest() }
        assertEquals(
            listOf(
                "POST /api/aiden/v1/bots/bot_fixture_01/handoffs/$waitId/answer",
                "POST /api/aiden/v1/bots/bot_fixture_01/handoffs/$waitId/open-on-mac",
                "POST /api/aiden/v1/bots/bot_fixture_01/pause",
                "DELETE /api/aiden/v1/bots/bot_fixture_01/pause"
            ),
            sent.map { "${it.method} ${it.path}" }
        )
        assertEquals(keys.map { it.toString().lowercase() }, sent.map { it.getHeader("Idempotency-Key") })
        assertEquals(answer.getValue("request"), Json.parseToJsonElement(sent[0].body.readUtf8()))
        assertEquals(openOnMac.getValue("request"), Json.parseToJsonElement(sent[1].body.readUtf8()))
        assertEquals(handoffs.getValue("pause").jsonObject.getValue("request"), Json.parseToJsonElement(sent[2].body.readUtf8()))
        assertEquals("Resume has no body", 0L, sent[3].bodySize)
        // Skip without a note sends only the outcome.
        assertEquals(
            Json.parseToJsonElement("""{"outcome":"skipped"}"""),
            wire.encodeToJsonElement(AidenBotHandoffAnswerRequest.serializer(), AidenBotHandoffAnswerRequest(AidenBotHandoffOutcome.SKIPPED))
        )

        // A receipt for another card is refused; a malformed wait id never leaves the phone.
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"waitId":"another-card"}"""))
        assertThrows(Exception::class.java) {
            runBlocking { client.answerBotHandoff("bot_fixture_01", waitId, request, UUID.randomUUID()) }
        }
        server.takeRequest()
        val before = server.requestCount
        assertThrows(Exception::class.java) {
            runBlocking { client.answerBotHandoff("bot_fixture_01", "wait/1", request, UUID.randomUUID()) }
        }
        assertEquals(before, server.requestCount)
    }
}
