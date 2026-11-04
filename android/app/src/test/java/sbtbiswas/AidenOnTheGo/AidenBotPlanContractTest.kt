package sbtbiswas.AidenOnTheGo

import kotlinx.serialization.json.*
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import sbtbiswas.AidenOnTheGo.features.bots.*
import sbtbiswas.AidenOnTheGo.features.remote.aidenRequestBotPlans
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.*
import java.time.Instant
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.*

class AidenBotPlanContractTest {
    private val wire = AidenBotWireJson.json
    private val root by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json")).bufferedReader().use { it.readText() }
        Json.parseToJsonElement(text).jsonObject
    }
    private val fixture get() = root.getValue("botPlans").jsonObject
    /** Literal review expectations, independent of the fixture and host formatting implementation. */
    private fun assertHostFolderReview(plan: AidenRemoteBotPlan) {
        assertEquals(listOf(
            "Google Calendar · create events (up to 5)",
            "Commands · in its own folder",
            "Files · change /Volumes/Backup/Family Photos for this plan",
            "Files · read ~/Documents/Tax Records"
        ), plan.items.map { it.line })
        assertEquals(listOf(
            listOf("Create event"), emptyList(),
            listOf("/Volumes/Backup/Family Photos", "Read and change · allowed once, for this plan only"),
            listOf("~/Documents/Tax Records")
        ), plan.items.map { it.details })
        assertEquals(0, plan.items.first().used)
        assertEquals(5, plan.items.first().max)
        plan.items.drop(1).forEach { assertNull(it.used); assertNull(it.max) }
    }
    private fun assertReadOnlyFolderReview(plan: AidenRemoteBotPlan) {
        assertEquals("plan-read-only-folder-56", plan.planId)
        assertEquals(AidenBotPlanStatus.PENDING, plan.status)
        assertEquals(listOf("Files · read /Volumes/Archive/Tax Records for this plan"), plan.items.map { it.line })
        assertEquals(listOf(listOf("/Volumes/Archive/Tax Records", "Read only · allowed once, for this plan only")), plan.items.map { it.details })
        assertNull(plan.items.first().used); assertNull(plan.items.first().max)
    }
    @Test fun canonicalSnapshotAndOrderedPlanFramesDecode() {
        assertEquals(56, root.getValue("contractRevision").jsonPrimitive.int)
        val session = wire.decodeFromJsonElement(AidenBotSession.serializer(), fixture.getValue("session"))
        assertEquals(0L, session.seq)
        assertHostFolderReview(requireNotNull(session.plan))
        val botId = fixture.getValue("session").jsonObject.getValue("botId").jsonPrimitive.content
        val frames = fixture.getValue("events").jsonArray.map { AidenBotSessionEventStream.decodeFrame(it.toString().toByteArray(), botId) }
        assertEquals(listOf(0L, 1L, 2L), frames.map { it.seq })
    }
    @Test fun canonicalPendingActiveSessionSseClearLegacyAndPrivacy() {
        val raw = root.toString()
        AidenRawJsonDuplicateKeyScanner.validate(raw)
        AidenBotPrivateResponseValidator.validate(raw, AidenBotPrivateResponseScope.SharedFixture)
        val pending = AidenRemoteBotPlan.parse(fixture.getValue("pending"))
        val active = AidenRemoteBotPlan.parse(fixture.getValue("active"))
        assertEquals(AidenBotPlanStatus.PENDING, pending.status)
        assertEquals(AidenBotPlanStatus.ACTIVE, active.status)
        assertHostFolderReview(pending)
        assertHostFolderReview(active)
        assertReadOnlyFolderReview(AidenRemoteBotPlan.parse(fixture.getValue("readOnlyFolderPlan")))
        assertEquals(1, active.completedSteps)
        var session = wire.decodeFromJsonElement(AidenBotSession.serializer(), fixture.getValue("session"))
        assertEquals(pending, session.plan)
        assertHostFolderReview(requireNotNull(session.plan))
        for (element in fixture.getValue("events").jsonArray) {
            val frame = AidenBotSessionEventStream.decodeFrame(element.toString().toByteArray(), session.botId)
            session = (aidenApplyBotSessionEvent(session, frame) as AidenBotSessionEventOutcome.Applied).session
            if (frame.seq <= 1) assertHostFolderReview(requireNotNull(session.plan))
        }
        assertNull(session.plan)
        val legacy = fixture.getValue("legacy").jsonObject
        session = wire.decodeFromJsonElement(AidenBotSession.serializer(), legacy.getValue("session"))
        assertNull(session.plan)
        for (element in legacy.getValue("events").jsonArray) {
            val frame = AidenBotSessionEventStream.decodeFrame(element.toString().toByteArray(), session.botId)
            session = (aidenApplyBotSessionEvent(session, frame) as AidenBotSessionEventOutcome.Applied).session
        }
        assertNull(session.plan)
    }
    @Test fun strictShapeBoundsCountersMissingNullAndPrivateKeys() {
        val base = fixture.getValue("pending").jsonObject
        fun changed(key: String, value: JsonElement) = JsonObject(base + (key to value))
        val bad = mutableListOf<JsonElement>()
        for (key in listOf("planId", "status", "title", "why", "steps", "items")) bad += JsonObject(base - key)
        for (key in listOf("expiresAt", "from")) bad += changed(key, JsonNull)
        for (key in listOf("botId", "revision", "authorization", "proposal", "id")) bad += changed(key, JsonPrimitive("private"))
        bad += changed("planId", JsonPrimitive("../plan")); bad += changed("status", JsonPrimitive("approved"))
        bad += changed("title", JsonPrimitive("x".repeat(81))); bad += changed("why", JsonPrimitive(" "))
        bad += changed("from", JsonPrimitive("a\u202Eb")); bad += changed("why", JsonPrimitive("a\u2028b"))
        bad += changed("steps", JsonArray(emptyList())); bad += changed("items", JsonArray(emptyList()))
        bad += changed("expiresAt", JsonPrimitive("2026-02-30T12:00:00Z"))
        val step = buildJsonObject { put("text", "Do this"); put("status", "pending") }
        bad += changed("steps", JsonArray(List(11) { step }))
        bad += changed("steps", JsonArray(listOf(JsonObject(step + ("id" to JsonPrimitive("private"))))))
        bad += changed("steps", JsonArray(listOf(JsonObject(step + ("text" to JsonPrimitive("x".repeat(201)))))))
        val item = buildJsonObject { put("line", "Calendar"); put("details", JsonArray(emptyList())) }
        val counts = listOf("{\"used\":0}", "{\"max\":1}", "{\"used\":null,\"max\":1}", "{\"used\":\"1\",\"max\":2}", "{\"used\":true,\"max\":2}", "{\"used\":-1,\"max\":2}", "{\"used\":3,\"max\":2}", "{\"used\":0,\"max\":26}", "{\"used\":0,\"max\":0}", "{\"id\":\"private\"}", "{\"fileScope\":{\"path\":\"/private/host-only\"}}")
        for (fields in counts.map { Json.parseToJsonElement(it).jsonObject }) bad += changed("items", JsonArray(listOf(JsonObject(item + fields))))
        bad += changed("items", JsonArray(listOf(JsonObject(item + ("details" to JsonArray(List(7) { JsonPrimitive("detail") }))))))
        bad.forEach { body -> assertThrows(Exception::class.java) { AidenRemoteBotPlan.parse(body) } }
        val maximum = JsonObject(base + mapOf(
            "title" to JsonPrimitive("🙂".repeat(80)), "why" to JsonPrimitive("w".repeat(300)),
            "steps" to JsonArray(List(10) { buildJsonObject { put("text", "s".repeat(200)); put("status", "skipped") } }),
            "items" to JsonArray(List(8) { buildJsonObject { put("line", "i".repeat(120)); put("details", JsonArray(List(6) { JsonPrimitive("d".repeat(160)) })); put("used", 25); put("max", 25) } })
        ))
        val decoded = AidenRemoteBotPlan.parse(maximum)
        assertEquals(10, decoded.completedSteps); assertEquals(25, decoded.items.last().used)
        val event = fixture.getValue("events").jsonArray[1].jsonObject
        for (payload in listOf(buildJsonObject {}, buildJsonObject { put("plan", JsonNull); put("extra", 1) }, buildJsonObject { put("plan", "bad") })) {
            assertThrows(Exception::class.java) { wire.decodeFromJsonElement(AidenBotSessionEvent.serializer(), JsonObject(event + ("payload" to payload))) }
        }
    }
    @Test fun planDatesMatchHostStrictCalendarAndFullRfc3339OffsetRange() {
        val base = fixture.getValue("active").jsonObject
        for (date in listOf("2026-11-04T13:00:00.123456789012+23:59", "2026-11-04T13:00:00-23:59", "0000-02-29T00:00:00Z")) {
            val value = AidenRemoteBotPlan.parse(JsonObject(base + ("expiresAt" to JsonPrimitive(date))))
            assertEquals(date, value.expiresAt)
            assertNotNull(value.expiry)
        }
        for (date in listOf("2026-02-30T12:00:00Z", "2026-11-04T24:00:00Z", "2026-11-04T13:00:60Z", "2026-11-04T13:00:00+24:00", "2026-11-04T13:00:00+00:60", "2026-11-04 13:00:00Z")) {
            assertThrows(Exception::class.java) { AidenRemoteBotPlan.parse(JsonObject(base + ("expiresAt" to JsonPrimitive(date)))) }
        }
    }
    @Test fun responseRouteBodyKeyAndIdentityStatusValidation() = runBlocking {
        val server = MockWebServer(); server.start()
        try {
            val client = AidenRemoteClient(server.url("/api/aiden/v1").toString().trimEnd('/'), "test_credential_123", customOkHttpClient = OkHttpClient())
            val botId = fixture.getValue("session").jsonObject.getValue("botId").jsonPrimitive.content
            for ((decision, text) in listOf(AidenBotPlanDecision.APPROVE to "approve", AidenBotPlanDecision.NOT_NOW to "not_now", AidenBotPlanDecision.STOP to "stop")) {
                val key = UUID.randomUUID()
                server.enqueue(MockResponse().setBody("{\"planId\":\"plan-fixture-56\",\"status\":\"stopped\"}"))
                assertEquals(AidenBotPlanStatus.STOPPED, client.respondBotPlan(botId, "plan-fixture-56", AidenBotPlanRespondRequest(decision), key).status)
                val request = server.takeRequest()
                assertEquals("POST", request.method)
                assertEquals("/api/aiden/v1/bots/$botId/plans/plan-fixture-56/respond", request.path)
                assertEquals(key.toString(), request.getHeader("Idempotency-Key"))
                assertEquals(buildJsonObject { put("decision", text) }, Json.parseToJsonElement(request.body.readUtf8()))
            }
            for (body in listOf("{\"planId\":\"wrong-plan\",\"status\":\"active\"}", "{\"planId\":\"plan-fixture-56\",\"status\":\"pending\"}", "{\"planId\":\"plan-fixture-56\",\"status\":\"active\",\"revision\":1}")) {
                server.enqueue(MockResponse().setBody(body))
                try { client.respondBotPlan(botId, "plan-fixture-56", AidenBotPlanRespondRequest(AidenBotPlanDecision.APPROVE), UUID.randomUUID()); fail("Invalid plan receipt accepted") } catch (_: Exception) {}
            }
        } finally { server.shutdown() }
    }
    private val base = listOf(AidenRemoteCapability.BOT_READ, AidenRemoteCapability.BOT_WRITE)
    private fun mac(held: List<AidenRemoteCapability>, offered: List<AidenRemoteCapability>) = AidenServer(
        protocolVersion = 1, instanceId = "fixture-mac", name = "Mac", capabilities = held, serverCapabilities = offered,
        features = emptyList(), connectionMode = AidenConnectionMode.LAN, serverTime = Instant.parse("2026-11-03T09:00:00Z"))
    private fun installation(held: List<AidenRemoteCapability>) = AidenInstallation(
        instanceId = "fixture-mac", endpoint = "http://localhost:4141/api/aiden/v1", name = "Mac", deviceId = "fixture-phone",
        serverSpkiSha256 = "sha256/test", createdAt = Instant.parse("2026-11-03T09:00:00Z"), deviceCapabilities = held, serverCapabilities = held)
    @Test fun negotiationIsSoloOfferedOnlyOldHostNonfatalAndGenerationFenced() = runBlocking {
        for (status in listOf(200, 400, 404)) {
            val server = MockWebServer(); server.start()
            try {
                val client = AidenRemoteClient(server.url("/api/aiden/v1").toString().trimEnd('/'), "test_credential_123", customOkHttpClient = OkHttpClient())
                assertNull(aidenRequestBotPlans(client, mac(base, base), installation(base)))
                assertEquals(0, server.requestCount)
                val grant = AidenRemoteCapability.BOT_PLANS; val granted = base + grant
                if (status == 200) {
                    server.enqueue(MockResponse().setBody(buildJsonObject { put("capabilities", JsonArray(granted.map { JsonPrimitive(it.rawValue) })) }.toString()))
                    server.enqueue(MockResponse().setBody(wire.encodeToString(AidenServer.serializer(), mac(granted, granted))))
                } else server.enqueue(MockResponse().setResponseCode(status).setBody("{\"error\":{\"code\":\"invalid_request\",\"message\":\"Unknown capability\",\"requestId\":\"test\",\"retryable\":false}}"))
                val result = aidenRequestBotPlans(client, mac(base, granted), installation(base))
                assertEquals(buildJsonObject { put("accepts", JsonArray(listOf(JsonPrimitive("bot:plans")))) }, Json.parseToJsonElement(server.takeRequest().body.readUtf8()))
                if (status == 200) {
                    assertTrue(requireNotNull(result).granted!!.contains(grant))
                    assertTrue(aidenBotSessionFeedGrants(installation(granted)).contains(grant))
                } else assertNull(result)
                assertNull(aidenRequestBotPlans(client, mac(base, granted), installation(base), stillCurrent = { false }))
                assertFalse(AidenRemoteCapability.V1_KNOWN.contains(grant))
            } finally { server.shutdown() }
        }
    }
}
