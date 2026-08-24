package sbtbiswas.AidenOnTheGo

import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteEventType
import java.time.Instant
import java.util.UUID

class AidenRemoteClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: AidenRemoteClient

    @Before
    fun setup() {
        server = MockWebServer()
        server.start()

        val endpoint = server.url("/api/aiden/v1").toString()
        val installation = AidenInstallation(
            instanceId = "test_instance",
            deviceId = "test_device",
            name = "Test Mac",
            endpoint = endpoint,
            serverSpkiSha256 = "sha256/test",
            deviceCapabilities = listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.CHAT_WRITE, AidenRemoteCapability.BOT_READ, AidenRemoteCapability.BOT_WRITE),
            serverCapabilities = listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.CHAT_WRITE, AidenRemoteCapability.BOT_READ, AidenRemoteCapability.BOT_WRITE),
            createdAt = Instant.now()
        )

        client = AidenRemoteClient(
            installation = installation,
            credential = "test_credential_123",
            customOkHttpClient = OkHttpClient.Builder().build()
        )
    }

    @After
    fun teardown() {
        server.shutdown()
    }

    @Test
    fun testServerInfoEndpoint() = runBlocking {
        val jsonResponse = """
            {
                "protocolVersion": 1,
                "instanceId": "test_instance",
                "name": "Sambit's Mac",
                "capabilities": ["server:read", "chat:read", "chat:write"],
                "serverCapabilities": ["server:read", "chat:read", "chat:write"],
                "appVersion": "1.0.0",
                "connectionMode": "lan",
                "serverTime": "2026-08-24T00:00:00.000Z"
            }
        """.trimIndent()

        server.enqueue(MockResponse().setBody(jsonResponse).setResponseCode(200))

        val serverInfo = client.server()
        val recorded = server.takeRequest()

        assertEquals("GET", recorded.method)
        assertEquals("/api/aiden/v1/server", recorded.path)
        assertEquals("Bearer test_credential_123", recorded.getHeader("Authorization"))
        assertEquals("test_instance", serverInfo.instanceId)
        assertEquals("Sambit's Mac", serverInfo.name)
        assertTrue(serverInfo.capabilities.contains(AidenRemoteCapability.CHAT_READ))
    }

    @Test
    fun testStartTurnEndpoint() = runBlocking {
        val jsonResponse = """
            {
                "turnId": "turn_123",
                "streamId": "stream_456",
                "status": "running",
                "message": {
                    "id": "msg_123",
                    "role": "user",
                    "text": "Hello Aiden",
                    "createdAt": "2026-08-24T00:00:00Z"
                }
            }
        """.trimIndent()

        server.enqueue(MockResponse().setBody(jsonResponse).setResponseCode(202))

        val turnStart = AidenTurnStart(text = "Hello Aiden")
        val idempotencyKey = UUID.randomUUID()
        val response = client.startTurn("chat_1", turnStart, idempotencyKey)

        val recorded = server.takeRequest()
        assertEquals("POST", recorded.method)
        assertEquals("/api/aiden/v1/chats/chat_1/turns", recorded.path)
        assertEquals(idempotencyKey.toString().lowercase(), recorded.getHeader("Idempotency-Key"))
        assertEquals("turn_123", response.turnId)
        assertEquals("stream_456", response.streamId)
        assertEquals(AidenChatRole.USER, response.message.role)
    }

    @Test
    fun testSSEStreamParsing() = runBlocking {
        val sseBody = """
            event: text_delta
            id: 1
            data: {"protocolVersion":1,"streamId":"stream_test","sequence":1,"timestamp":"2026-08-24T00:00:00Z","type":"text_delta","payload":{"text":"Hello "}}

            event: text_delta
            id: 2
            data: {"protocolVersion":1,"streamId":"stream_test","sequence":2,"timestamp":"2026-08-24T00:00:01Z","type":"text_delta","payload":{"text":"World!"}}

            event: done
            id: 3
            data: {"protocolVersion":1,"streamId":"stream_test","sequence":3,"timestamp":"2026-08-24T00:00:02Z","type":"done","payload":{"messageId":"msg_done"}}

        """.trimIndent()

        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody(sseBody)
                .setResponseCode(200)
        )

        val events = client.openStream("chat_1", "stream_test").toList()

        assertEquals(3, events.size)
        assertEquals(AidenRemoteEventType.TEXT_DELTA, events[0].type)
        assertEquals(AidenRemoteEventType.TEXT_DELTA, events[1].type)
        assertEquals(AidenRemoteEventType.DONE, events[2].type)
        assertTrue(events[2].type.isTerminal)
    }

    @Test
    fun testBotLifecycleAndIfMatchHeaders() = runBlocking {
        // 1. Bot list
        server.enqueue(
            MockResponse().setResponseCode(200).setBody("""
                {"bots":[],"maxBots":256,"favorites":{"botIds":[],"revision":"fav_0"}}
            """.trimIndent())
        )
        val bots = client.bots(includeArchived = true)
        val listRequest = server.takeRequest()
        assertEquals("GET", listRequest.method)
        assertEquals("/api/aiden/v1/bots?includeArchived=true", listRequest.path)
        assertEquals(0, bots.bots.size)

        // 2. Update bot identity with If-Match
        server.enqueue(
            MockResponse().setResponseCode(200).setBody("""
                {
                    "id": "bot_1", "name": "Renamed Bot", "purpose": "Updated",
                    "instructions": "Be helpful and concise.",
                    "avatar": {"semantic": {"version": 1, "shape": "orb", "color": "sky", "eyes": "wide", "detail": "orbit"}},
                    "health": "ready", "createdAt": "2026-08-24T00:00:00Z", "updatedAt": "2026-08-24T01:00:00Z",
                    "revision": "rev_2",
                    "access": {"botId": "bot_1", "accessMode": "full", "revision": "pol_1", "policyEpoch": "epoch_1", "summary": "Full access"}
                }
            """.trimIndent())
        )
        val patch = AidenBotIdentityPatch(name = "Renamed Bot", purpose = "Updated")
        client.updateBotIdentity("bot_1", "rev_1", patch)
        val patchRequest = server.takeRequest()
        assertEquals("PATCH", patchRequest.method)
        assertEquals("/api/aiden/v1/bots/bot_1", patchRequest.path)
        assertEquals("rev_1", patchRequest.getHeader("If-Match"))

        // 3. Put bot avatar with If-Match & Idempotency-Key
        server.enqueue(
            MockResponse().setResponseCode(200).setBody("""
                {
                    "assetRevision": "avatar_rev_1",
                    "mimeType": "image/png",
                    "width": 512,
                    "height": 512,
                    "byteSize": 1024
                }
            """.trimIndent())
        )
        val upload = AidenBotAvatarUpload(mimeType = AidenBotAvatarUploadMimeType.PNG, data = "iVBORw0KGgo=")
        val uploadKey = UUID.randomUUID()
        client.putBotAvatar("bot_1", "rev_2", upload, uploadKey)
        val uploadRequest = server.takeRequest()
        assertEquals("PUT", uploadRequest.method)
        assertEquals("/api/aiden/v1/bots/bot_1/avatar", uploadRequest.path)
        assertEquals("rev_2", uploadRequest.getHeader("If-Match"))
        assertEquals(uploadKey.toString().lowercase(), uploadRequest.getHeader("Idempotency-Key"))

        // 4. Delete bot avatar with If-Match
        server.enqueue(
            MockResponse().setResponseCode(200).setBody("""
                {
                    "id": "bot_1", "name": "Renamed Bot", "purpose": "Updated",
                    "instructions": "Be helpful and concise.",
                    "avatar": {"semantic": {"version": 1, "shape": "orb", "color": "sky", "eyes": "wide", "detail": "orbit"}},
                    "health": "ready", "createdAt": "2026-08-24T00:00:00Z", "updatedAt": "2026-08-24T01:00:00Z",
                    "revision": "rev_3",
                    "access": {"botId": "bot_1", "accessMode": "full", "revision": "pol_1", "policyEpoch": "epoch_1", "summary": "Full access"}
                }
            """.trimIndent())
        )
        client.deleteBotAvatar("bot_1", "rev_2")
        val deleteRequest = server.takeRequest()
        assertEquals("DELETE", deleteRequest.method)
        assertEquals("/api/aiden/v1/bots/bot_1/avatar", deleteRequest.path)
        assertEquals("rev_2", deleteRequest.getHeader("If-Match"))
    }

    @Test
    fun testCredentialRevocationHandling() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(401).setBody("""
                {
                    "error": {
                        "code": "credential_revoked",
                        "message": "Pair this device again.",
                        "requestId": "req_revoked_1",
                        "retryable": false
                    }
                }
            """.trimIndent())
        )

        try {
            client.workspaces()
            fail("Expected credential revoked exception")
        } catch (e: AidenRemoteClientException.Server) {
            assertEquals(401, e.statusCode)
            assertEquals(AidenRemoteErrorCode.CREDENTIAL_REVOKED, e.body.code)
            assertFalse(e.message?.contains("test_credential_123") == true)
        }
    }

    @Test
    fun testUsageEndpoint() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody("""
                {
                    "range": "30d",
                    "startDate": "2026-07-25",
                    "endDate": "2026-08-24",
                    "totals": {
                        "requests": 15,
                        "completedRequests": 15,
                        "failedRequests": 0,
                        "cancelledRequests": 0,
                        "reportedTokenRequests": 15,
                        "unmeteredRequests": 0,
                        "localRequests": 0,
                        "costedRequests": 15,
                        "unpricedHostedRequests": 0,
                        "hostedCostUsd": 0.45,
                        "activeDays": 5,
                        "currentStreak": 2,
                        "longestStreak": 3,
                        "tokens": {
                            "input": 1500,
                            "output": 500,
                            "cacheRead": 100,
                            "cacheWrite": 50,
                            "cacheWrite1h": 0,
                            "reasoning": 200,
                            "total": 2350
                        }
                    },
                    "days": [],
                    "models": []
                }
            """.trimIndent())
        )

        val usage = client.usage()
        val recorded = server.takeRequest()
        assertEquals("GET", recorded.method)
        assertEquals("/api/aiden/v1/usage?range=30d", recorded.path)
        assertEquals("30d", usage.range)
        assertEquals(15, usage.totals.requests)
        assertEquals(2350, usage.totals.tokens.total)
    }
}

