package sbtbiswas.AidenOnTheGo

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotSessionEventOutcome
import sbtbiswas.AidenOnTheGo.features.bots.aidenApplyBotSessionEvent
import sbtbiswas.AidenOnTheGo.features.bots.aidenBotSessionFeedGrants
import sbtbiswas.AidenOnTheGo.features.remote.aidenRequestBotAccessRequests
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.*
import java.util.UUID

/** Revision 55, using the same access-request fixtures as the host and iOS. */
class AidenBotAccessRequestsContractTest {
    private val wire = AidenBotWireJson.json
    private val root by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json")).bufferedReader().use { it.readText() }
        AidenRawJsonDuplicateKeyScanner.validate(text)
        AidenBotPrivateResponseValidator.validate(text, AidenBotPrivateResponseScope.SharedFixture)
        Json.parseToJsonElement(text).jsonObject
    }
    private val fixture get() = root.getValue("botAccessRequests").jsonObject
    private fun snapshot(element: JsonElement) = wire.decodeFromJsonElement(AidenBotSession.serializer(), element)
    private fun frame(element: JsonElement) = AidenBotSessionEventStream.decodeFrame(element.toString().toByteArray(), "bot_fixture_01")

    @Test fun canonicalCardsSessionFramesIssuesAndLegacySettlement() {
        assertEquals(59, root.getValue("contractRevision").jsonPrimitive.int)
        assertEquals("bot:access-requests", fixture.getValue("capability").jsonPrimitive.content)
        val folder = AidenBotAccessRequest.parse(fixture.getValue("folder"))
        val mac = AidenBotAccessRequest.parse(fixture.getValue("wholeMac"))
        assertEquals(listOf(AidenBotAccessRequestChoice.NOT_NOW, AidenBotAccessRequestChoice.ALWAYS, AidenBotAccessRequestChoice.ONCE), folder.choices)
        assertEquals(listOf(AidenBotAccessRequestChoice.NOT_NOW, AidenBotAccessRequestChoice.ONCE), mac.choices)
        assertNull(mac.place)
        assertEquals("your whole Mac", mac.label)
        var session = snapshot(fixture.getValue("session"))
        assertEquals(folder, session.accessRequest)
        for (event in fixture.getValue("events").jsonArray.map(::frame)) {
            session = (aidenApplyBotSessionEvent(session, event) as AidenBotSessionEventOutcome.Applied).session
        }
        assertNull(session.accessRequest)
        val issue = wire.decodeFromJsonElement(AidenBotIssue.serializer(), fixture.getValue("issue"))
        assertEquals(AidenBotIssueKind.ACCESS_NEEDED, issue.kind)
        assertFalse(issue.isAvailable())
        assertTrue(issue.isAvailable(accessRequests = true))
        assertEquals(listOf(AidenBotIssueActionKind.DISMISS_ACCESS, AidenBotIssueActionKind.ALLOW_FOLDER), issue.actions.map { it.kind })
        val receipt = wire.decodeFromJsonElement(AidenBotAccessAnswerReceipt.serializer(), fixture.getValue("answer").jsonObject.getValue("response"))
        assertEquals(true, receipt.savedForFuture)
        val legacy = fixture.getValue("legacy").jsonObject
        var oldSession = snapshot(legacy.getValue("session"))
        assertEquals(1, oldSession.entries.size)
        for (event in legacy.getValue("events").jsonArray.map(::frame)) {
            oldSession = (aidenApplyBotSessionEvent(oldSession, event) as AidenBotSessionEventOutcome.Applied).session
        }
        assertEquals(snapshot(legacy.getValue("settledSession")), oldSession)
        assertTrue(oldSession.entries.isEmpty())
    }

    @Test fun malformedCardsAndReceiptsAreRejected() {
        val folder = fixture.getValue("folder").jsonObject
        val mac = fixture.getValue("wholeMac").jsonObject
        fun changed(original: JsonObject, key: String, value: JsonElement) = JsonObject(original + (key to value))
        val invalid = listOf(
            changed(folder, "choices", JsonArray(listOf("once", "not_now").map(::JsonPrimitive))),
            changed(folder, "choices", JsonArray(listOf("not_now", "once", "once").map(::JsonPrimitive))),
            changed(folder, "waitId", JsonPrimitive("../wait")),
            changed(folder, "label", JsonPrimitive("x".repeat(121))),
            changed(folder, "why", JsonPrimitive(" ")),
            changed(folder, "why", JsonPrimitive("x".repeat(401))),
            changed(folder, "place", JsonPrimitive("~")),
            changed(folder, "place", JsonPrimitive("relative/path")),
            changed(folder, "place", JsonNull),
            changed(folder, "authorization", buildJsonObject { put("root", "/private") }),
            changed(mac, "choices", JsonArray(listOf("not_now", "always", "once").map(::JsonPrimitive))),
            changed(mac, "label", JsonPrimitive("Mac")),
            changed(mac, "place", JsonPrimitive("/"))
        )
        invalid.forEach { body -> assertThrows(Exception::class.java) { AidenBotAccessRequest.parse(body) } }
        for (body in listOf("""{"answered":false}""", """{"answered":"true"}""", """{"answered":true,"extra":true}""")) {
            assertThrows(Exception::class.java) { wire.decodeFromString(AidenBotAccessAnswerReceipt.serializer(), body) }
        }
    }

    @Test fun receiptAcceptsOnlyAbsentOrTrueFutureFlag() {
        wire.decodeFromString(AidenBotAccessAnswerReceipt.serializer(), """{"answered":true}""")
        wire.decodeFromString(AidenBotAccessAnswerReceipt.serializer(), """{"answered":true,"savedForFuture":true}""")
        for (flag in listOf("false", "null", "1", "\"true\"")) {
            assertThrows(Exception::class.java) { wire.decodeFromString(AidenBotAccessAnswerReceipt.serializer(), """{"answered":true,"savedForFuture":$flag}""") }
        }
        for (key in listOf("authorization", "grant", "unknown")) {
            assertThrows(Exception::class.java) { wire.decodeFromString(AidenBotAccessAnswerReceipt.serializer(), """{"answered":true,"$key":true}""") }
        }
    }

    @Test fun dismissAccessIsClosedAndLimitedToAccessIssues() {
        val issue = fixture.getValue("issue").jsonObject
        val action = buildJsonObject { put("kind", "dismiss_access") }
        val body = JsonObject(issue + ("actions" to JsonArray(listOf(action))))
        val card = wire.decodeFromJsonElement(AidenBotIssue.serializer(), body)
        assertFalse(card.isAvailable())
        assertTrue(card.isAvailable(accessRequests = true))
        assertThrows(Exception::class.java) {
            wire.decodeFromJsonElement(AidenBotIssue.serializer(), JsonObject(body + ("kind" to JsonPrimitive("run_stalled"))))
        }
        assertThrows(Exception::class.java) {
            wire.decodeFromJsonElement(AidenBotIssueAction.serializer(), JsonObject(action + ("routineId" to JsonNull)))
        }
        for (extra in listOf("routineId", "authorization", "unknown")) {
            assertThrows(Exception::class.java) {
                wire.decodeFromJsonElement(AidenBotIssueAction.serializer(), JsonObject(action + (extra to JsonPrimitive("routine-1"))))
            }
        }
    }

    @Test fun eachAnswerUsesItsOwnRouteBodyAndIdempotencyHeader() = runBlocking {
        val server = MockWebServer(); server.start()
        try {
            val client = AidenRemoteClient(server.url("/api/aiden/v1").toString().trimEnd('/'), "test_credential_123", customOkHttpClient = OkHttpClient())
            val waitId = AidenBotAccessRequest.parse(fixture.getValue("folder")).waitId
            for ((choice, expected) in listOf(AidenBotAccessRequestChoice.NOT_NOW to "not_now", AidenBotAccessRequestChoice.ALWAYS to "always", AidenBotAccessRequestChoice.ONCE to "once")) {
                val response = if (choice == AidenBotAccessRequestChoice.ALWAYS) fixture.getValue("answer").jsonObject.getValue("response").toString() else """{"answered":true}"""
                server.enqueue(MockResponse().setBody(response))
                val key = UUID.randomUUID()
                val receipt = client.answerBotAccessRequest("bot_fixture_01", waitId, AidenBotAccessAnswerRequest(choice), key)
                assertTrue(receipt.answered)
                assertEquals(if (choice == AidenBotAccessRequestChoice.ALWAYS) true else null, receipt.savedForFuture)
                val request = server.takeRequest()
                assertEquals("POST", request.method)
                assertEquals("/api/aiden/v1/bots/bot_fixture_01/access-requests/$waitId/answer", request.path)
                assertEquals(key.toString(), request.getHeader("Idempotency-Key"))
                assertEquals(buildJsonObject { put("choice", expected) }, Json.parseToJsonElement(request.body.readUtf8()))
            }
        } finally { server.shutdown() }
    }

    private val base = listOf(AidenRemoteCapability.BOT_READ, AidenRemoteCapability.BOT_WRITE)
    private fun mac(held: List<AidenRemoteCapability>, offered: List<AidenRemoteCapability>) = AidenServer(
        protocolVersion = 1, instanceId = "fixture-mac", name = "Mac", capabilities = held,
        serverCapabilities = offered, features = emptyList(), connectionMode = AidenConnectionMode.LAN,
        serverTime = java.time.Instant.parse("2026-11-03T09:00:00Z")
    )
    private fun installation(held: List<AidenRemoteCapability>) = AidenInstallation(
        instanceId = "fixture-mac", endpoint = "http://localhost:4141/api/aiden/v1", name = "Mac", deviceId = "fixture-phone",
        serverSpkiSha256 = "sha256/test", createdAt = java.time.Instant.parse("2026-11-03T09:00:00Z"), deviceCapabilities = held,
        serverCapabilities = held
    )
    @Test fun capabilityNegotiationIsSoloAnnouncedOnlyAndRefusalsAreNonfatal() = runBlocking {
        for (status in listOf(200, 400, 404)) {
            val server = MockWebServer(); server.start()
            try {
                val client = AidenRemoteClient(server.url("/api/aiden/v1").toString().trimEnd('/'), "test_credential_123", customOkHttpClient = OkHttpClient())
                assertNull(aidenRequestBotAccessRequests(client, mac(base, base), installation(base)))
                assertEquals(0, server.requestCount)
                val grant = AidenRemoteCapability.BOT_ACCESS_REQUESTS
                val granted = base + grant
                if (status == 200) {
                    server.enqueue(MockResponse().setBody(buildJsonObject { put("capabilities", JsonArray(granted.map { JsonPrimitive(it.rawValue) })) }.toString()))
                    server.enqueue(MockResponse().setBody(wire.encodeToString(AidenServer.serializer(), mac(granted, granted))))
                } else server.enqueue(MockResponse().setResponseCode(status).setBody("""{"error":{"code":"invalid_request","message":"Unknown capability","requestId":"test","retryable":false}}"""))
                val result = aidenRequestBotAccessRequests(client, mac(base, granted), installation(base))
                assertEquals(buildJsonObject { put("accepts", JsonArray(listOf(JsonPrimitive("bot:access-requests")))) }, Json.parseToJsonElement(server.takeRequest().body.readUtf8()))
                if (status == 200) {
                    assertTrue(requireNotNull(result).granted!!.contains(grant))
                    assertTrue(aidenBotSessionFeedGrants(installation(granted)).contains(grant))
                } else assertNull(result)
            } finally { server.shutdown() }
        }
    }
}
