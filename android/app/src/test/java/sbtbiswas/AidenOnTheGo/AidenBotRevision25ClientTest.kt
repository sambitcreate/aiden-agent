package sbtbiswas.AidenOnTheGo

import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import sbtbiswas.AidenOnTheGo.features.bots.AidenRemoteBotDeleter
import sbtbiswas.AidenOnTheGo.features.bots.aidenBotRoutineWriteFailure
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenBotContractException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import java.time.Instant
import java.util.UUID

/** Revision 25 Bot routes over HTTP, against the shared fixture payloads. */
class AidenBotRevision25ClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: AidenRemoteClient

    private val fixture: JsonObject by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json")) { "contract.json" }
            .bufferedReader().use { it.readText() }
        Json.parseToJsonElement(text).jsonObject
    }

    private fun pair(key: String, part: String): JsonElement = fixture.getValue(key).jsonObject.getValue(part)

    private fun ok(body: JsonElement, code: Int = 200) =
        MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body.toString())

    private fun error(code: Int, errorCode: String) = MockResponse().setResponseCode(code).setBody(
        """{"error":{"code":"$errorCode","message":"Nope.","requestId":"req_1","retryable":false}}"""
    )

    @Before
    fun setup() {
        server = MockWebServer()
        server.start()
        val capabilities = listOf(
            AidenRemoteCapability.BOT_READ, AidenRemoteCapability.BOT_WRITE, AidenRemoteCapability.CHAT_WRITE,
            AidenRemoteCapability.APPROVAL_RESPOND
        )
        client = AidenRemoteClient(
            installation = AidenInstallation(
                instanceId = "test_instance",
                deviceId = "test_device",
                name = "Test Mac",
                endpoint = server.url("/api/aiden/v1").toString(),
                serverSpkiSha256 = "sha256/test",
                deviceCapabilities = capabilities,
                serverCapabilities = capabilities,
                createdAt = Instant.now()
            ),
            credential = "test_credential_123",
            customOkHttpClient = OkHttpClient.Builder().build()
        )
    }

    @After
    fun teardown() {
        server.shutdown()
    }

    @Test
    fun aRevision24BotListFailsWithThePlainUpdateMessageInsteadOfASerializerDump() = runBlocking {
        // A revision-24 Mac still sends Favorites and Archived Bots.
        val list = fixture.getValue("botList").jsonObject
        val summary = list.getValue("bots").jsonArray[0].jsonObject
        val revision24 = JsonObject(
            list + ("bots" to JsonArray(listOf(JsonObject(summary + ("health" to JsonPrimitive("archived")))))) +
                ("favorites" to Json.parseToJsonElement("""{"botIds":[],"revision":"fav_1"}"""))
        )
        server.enqueue(ok(revision24))
        try {
            client.bots()
            fail("A revision-24 list must not decode")
        } catch (e: AidenBotContractException) {
            assertTrue(e.message!!.startsWith("Aiden Agent returned Bot information this version"))
        }

        // The current shape still decodes through the same route.
        server.enqueue(ok(list))
        assertEquals("bot_fixture_01", client.bots().bots.single().id)
    }

    @Test
    fun startChatOnAPresetAcceptsBothTheCreatingAndTheReplayedAnswer() = runBlocking {
        val created = pair("botPresetCreate", "response").jsonObject
        val replayed = JsonObject(created + ("created" to JsonPrimitive(false)))
        server.enqueue(ok(created, 201))
        server.enqueue(ok(replayed, 200))
        val key = UUID.randomUUID()

        val first = client.createBotFromPreset("chief-of-staff", key)
        val second = client.createBotFromPreset("chief-of-staff", key)

        assertTrue(first.created)
        assertFalse(second.created)
        assertEquals(first.bot.id, second.bot.id)
        val request = server.takeRequest()
        assertEquals("/api/aiden/v1/bots/from-preset", request.path)
        assertEquals(key.toString(), request.getHeader("Idempotency-Key"))
        assertEquals("""{"presetId":"chief-of-staff"}""", request.body.readUtf8())
        assertEquals(key.toString(), server.takeRequest().getHeader("Idempotency-Key"))
    }

    @Test
    fun deletingFromTheHomeABotAlreadyDeletedElsewhereSucceedsWithoutADeleteRequest() = runBlocking {
        // The Bot was deleted on the Mac or another phone: reading its revision answers 404.
        server.enqueue(error(404, "not_found"))
        AidenRemoteBotDeleter.delete(client, "bot_fixture_01")
        val read = server.takeRequest()
        assertEquals("GET", read.method)
        assertEquals("/api/aiden/v1/bots/bot_fixture_01", read.path)
        assertEquals(1, server.requestCount)

        // Any other failure is still shown as not deleted.
        server.enqueue(error(500, "internal_error"))
        try {
            AidenRemoteBotDeleter.delete(client, "bot_fixture_01")
            fail("A server failure must not count as deleted")
        } catch (e: AidenRemoteClientException.Server) {
            assertEquals(500, e.statusCode)
        }
    }

    @Test
    fun deleteSendsTheRevisionAndTreatsAnAlreadyGoneBotAsDeleted() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(204))
        server.enqueue(error(404, "not_found"))
        client.deleteBot("bot_fixture_01", "rev_7")
        client.deleteBot("bot_fixture_01", "rev_7")
        val request = server.takeRequest()
        assertEquals("DELETE", request.method)
        assertEquals("/api/aiden/v1/bots/bot_fixture_01", request.path)
        assertEquals("rev_7", request.getHeader("If-Match"))

        // Any other refusal is still a failure the screen must show.
        server.enqueue(error(409, "revision_conflict"))
        try {
            client.deleteBot("bot_fixture_01", "rev_6")
            fail("A stale delete must fail")
        } catch (e: AidenRemoteClientException.Server) {
            assertEquals(409, e.statusCode)
        }
    }

    @Test
    fun aStaleRoutineRevisionIsAConflictTheProfileReloadsFor() = runBlocking {
        server.enqueue(error(409, "revision_conflict"))
        val failure = try {
            client.updateBotRoutine("bot_fixture_01", "routine_fixture_01", "old_rev", AidenBotRoutineUpdateRequest(enabled = false))
            null
        } catch (e: AidenRemoteClientException.Server) {
            e
        }
        assertNotNull(failure)
        assertEquals(AidenRemoteErrorCode.REVISION_CONFLICT, failure!!.body.code)
        assertEquals("old_rev", server.takeRequest().getHeader("If-Match"))

        val meaning = aidenBotRoutineWriteFailure(failure, "fallback")
        assertTrue(meaning.reload)
        assertEquals("This routine changed on your Mac. Check it and try again.", meaning.message)
        // A dropped connection is not a conflict: keep the list and offer a retry.
        val offline = aidenBotRoutineWriteFailure(java.io.IOException("offline"), "fallback")
        assertFalse(offline.reload)
        assertEquals("fallback", offline.message)
    }

    @Test
    fun aConnectionRequestForAnUnknownPluginIsARefusalNotACrash() = runBlocking {
        server.enqueue(error(404, "not_found"))
        try {
            client.requestBotConnection("bot_fixture_01", "not-a-plugin", UUID.randomUUID())
            fail("Unknown plugin must be refused")
        } catch (e: AidenRemoteClientException.Server) {
            assertEquals(404, e.statusCode)
        }
        server.enqueue(ok(pair("botConnectionRequest", "response")))
        val receipt = client.requestBotConnection("bot_fixture_01", "google-calendar", UUID.randomUUID())
        assertEquals(AidenBotConnectionRequestStatus.SENT, receipt.status)
    }

    @Test
    fun theSessionFeedDeliversFramesInOrderAndRejectsAnotherBotsFrames() = runBlocking {
        val events = fixture.getValue("botSessionEvents").jsonArray
        val body = events.joinToString("") { "data: $it\n\n" }
        server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody(body))
        val received = client.botSessionEvents("bot_fixture_01").toList()
        assertEquals(events.size, received.size)
        assertEquals(listOf("snapshot", "partial", "entry", "state", "closed", "state", "question", "question", "approval", "approval"), received.map { it.type })
        assertEquals("/api/aiden/v1/bots/bot_fixture_01/session/events", server.takeRequest().path)

        server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody(body))
        try {
            client.botSessionEvents("bot_other").toList()
            fail("Frames for another Bot must be rejected")
        } catch (e: sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException) {
            assertEquals(sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException.InvalidStreamIdentity, e)
        }
    }

    @Test
    fun aBotApprovalIsAnsweredOnTheGenericApprovalRouteWithoutAScope() = runBlocking {
        val transport = sbtbiswas.AidenOnTheGo.features.bots.AidenRemoteBotSessionTransport(client)
        val waitId = "8d1e2f3a-4b5c-4d6e-9f70-a1b2c3d4e5f6"
        val key = UUID.randomUUID()
        server.enqueue(ok(Json.parseToJsonElement("""{"approvalId":"$waitId","decision":"allow","resolvedAt":"2026-08-19T15:02:00.000Z"}""")))
        val receipt = transport.respondToApproval(waitId, AidenApprovalDecision.ALLOW, key)
        assertEquals(waitId, receipt.approvalId)
        assertEquals(AidenApprovalDecision.ALLOW, receipt.decision)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/aiden/v1/approvals/$waitId/respond", request.path)
        assertEquals(key.toString(), request.getHeader("Idempotency-Key"))
        assertEquals("""{"decision":"allow"}""", request.body.readUtf8())

        // A settled approval is a refusal the caller can tell apart.
        server.enqueue(error(409, "approval_already_resolved"))
        try {
            transport.respondToApproval(waitId, AidenApprovalDecision.DENY, UUID.randomUUID())
            fail("A settled approval must be refused")
        } catch (e: AidenRemoteClientException.Server) {
            assertEquals(AidenRemoteErrorCode.APPROVAL_ALREADY_RESOLVED, e.body.code)
        }
        assertEquals("""{"decision":"deny"}""", server.takeRequest().body.readUtf8())
    }

    // --- Contract revision 27 ---

    @Test
    fun memoryIsReadAndEditedWithAnIdempotencyKey() = runBlocking {
        server.enqueue(ok(fixture.getValue("botMemory")))
        assertEquals(3, client.botMemory("bot_fixture_01").entryCount)
        assertEquals("/api/aiden/v1/bots/bot_fixture_01/memory", server.takeRequest().path)

        server.enqueue(ok(pair("botMemoryEdit", "response")))
        val key = UUID.randomUUID()
        val view = client.editBotMemory(
            "bot_fixture_01",
            AidenBotMemoryEdit.Replace(AidenBotMemoryTarget.USER, "0f1e2d3c4b5a6978", "Prefers short, friendly answers."),
            key
        )
        assertEquals("7a7a7a7a7a7a7a7a", view.revision)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/aiden/v1/bots/bot_fixture_01/memory/edits", request.path)
        assertEquals(key.toString(), request.getHeader("Idempotency-Key"))
        assertEquals(pair("botMemoryEdit", "request"), Json.parseToJsonElement(request.body.readUtf8()))

        // Each refusal the fixture lists reaches the caller with its own code.
        for (refusal in fixture.getValue("botMemoryEdit").jsonObject.getValue("errors").jsonArray) {
            val status = refusal.jsonObject.getValue("status").toString().toInt()
            val code = (refusal.jsonObject.getValue("code") as JsonPrimitive).content
            server.enqueue(error(status, code))
            try {
                client.editBotMemory("bot_fixture_01", AidenBotMemoryEdit.Clear, UUID.randomUUID())
                fail("$code must be refused")
            } catch (e: AidenRemoteClientException.Server) {
                assertEquals(status, e.statusCode)
                assertEquals(code, e.body.code.rawValue)
            }
            server.takeRequest()
        }

        // Another Bot's memory is never accepted for this one.
        server.enqueue(ok(fixture.getValue("botMemory")))
        try {
            client.botMemory("bot_other")
            fail("Another Bot's memory must be rejected")
        } catch (_: AidenRemoteClientException) {
        }
    }

    @Test
    fun aProposalAnswerPostsTheDecisionWithAnIdempotencyKey() = runBlocking {
        val proposalId = "7d0c5c8e-2f0b-4c4e-9a59-3b6f1f0e9a11"
        val key = UUID.randomUUID()
        server.enqueue(ok(pair("botRoutineProposalRespond", "response")))
        val result = client.respondToBotRoutineProposal("bot_fixture_01", proposalId, AidenBotRoutineProposalDecision.ACCEPT, key)
        assertEquals("task_fixture_routine_03", result.routineId)
        val request = server.takeRequest()
        assertEquals("/api/aiden/v1/bots/bot_fixture_01/routine-proposals/$proposalId/respond", request.path)
        assertEquals(key.toString(), request.getHeader("Idempotency-Key"))
        assertEquals(pair("botRoutineProposalRespond", "request"), Json.parseToJsonElement(request.body.readUtf8()))

        server.enqueue(error(404, "routine_proposal_not_found"))
        try {
            client.respondToBotRoutineProposal("bot_fixture_01", proposalId, AidenBotRoutineProposalDecision.DISMISS, UUID.randomUUID())
            fail("A missing proposal must be refused")
        } catch (e: AidenRemoteClientException.Server) {
            assertEquals(AidenRemoteErrorCode.ROUTINE_PROPOSAL_NOT_FOUND, e.body.code)
        }
    }

    @Test
    fun suggestionsAndTheRoutineFeedUseTheirRoutes() = runBlocking {
        server.enqueue(ok(fixture.getValue("botRoutineSuggestions")))
        assertEquals("Daily check-in", client.botRoutineSuggestions("bot_fixture_01").suggestions.single().name)
        assertEquals("/api/aiden/v1/bots/bot_fixture_01/routine-suggestions", server.takeRequest().path)

        server.enqueue(ok(fixture.getValue("botRoutineNotifications")))
        server.enqueue(ok(fixture.getValue("botRoutineNotifications")))
        client.botRoutineNotifications()
        assertEquals("/api/aiden/v1/bots/routine-notifications", server.takeRequest().path)
        client.botRoutineNotifications(Instant.parse("2026-08-19T15:01:00Z"))
        val since = server.takeRequest().requestUrl!!.queryParameter("since")
        assertEquals("2026-08-19T15:01:00.000Z", since)
    }

    @Test
    fun theBotCardGrantIsNegotiatedLikeTheOtherPhoneGrants() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(
            """{"capabilities":["chat:read","chat:write","bot:read","bot:write","bot:cards"]}"""
        ))
        val granted = client.updateDeviceCapabilities(listOf(AidenRemoteCapability.BOT_CARDS))
        assertTrue(granted.contains(AidenRemoteCapability.BOT_CARDS))
        assertEquals(
            listOf("bot:cards"),
            Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject.getValue("accepts").jsonArray
                .map { (it as JsonPrimitive).content }
        )
    }
}
