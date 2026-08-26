package sbtbiswas.AidenOnTheGo

import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteEventType
import java.time.Instant
import java.util.Base64
import java.util.UUID
import java.util.concurrent.TimeUnit

class AidenRemoteClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: AidenRemoteClient
    private lateinit var httpClient: OkHttpClient

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

        httpClient = OkHttpClient.Builder().build()
        client = AidenRemoteClient(
            installation = installation,
            credential = "test_credential_123",
            customOkHttpClient = httpClient
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
        val exactText = """NFC café | NFD cafe\u0301 | 👩🏽‍💻 | /Users/example/Aiden Projects/π.kt | C:\Users\example\Aiden Projects\pi.kt | /api/aiden/v1/chats/chat_01?after=42 | https://example.test/a%2Fb?q=hello%20world#résumé | UUID 123e4567-e89b-12d3-a456-426614174000 | base64 SGVsbG8sIFdvcmxkIQ== | hex deadbeef0123456789ABCDEF | Authorization: Bearer visible-placeholder | visible prose keys Reasoning_Content Tool-Arguments tool.result S_e.c-r e t"""
        val jsonResponse = """
            {
                "turnId": "turn_123",
                "streamId": "stream_456",
                "status": "running",
                "subagents": {"version": 2, "runIds": ["run-private"]},
                "message": {
                    "id": "msg_123",
                    "role": "user",
                    "text": ${Json.encodeToString(exactText)},
                    "childRunId": "run-private",
                    "childTranscript": [{"role": "assistant", "text": "private child text"}],
                    "createdAt": "2026-08-24T00:00:00Z"
                }
            }
        """.trimIndent()

        server.enqueue(MockResponse().setBody(jsonResponse).setResponseCode(202))

        val turnStart = AidenTurnStart(text = exactText)
        val idempotencyKey = UUID.randomUUID()
        val response = client.startTurn("chat_1", turnStart, idempotencyKey)

        val recorded = server.takeRequest()
        assertEquals("POST", recorded.method)
        assertEquals("/api/aiden/v1/chats/chat_1/turns", recorded.path)
        assertEquals(idempotencyKey.toString().lowercase(), recorded.getHeader("Idempotency-Key"))
        val requestBody = Json.parseToJsonElement(recorded.body.readUtf8()).jsonObject
        assertEquals(setOf("text"), requestBody.keys)
        assertEquals(exactText, requestBody.getValue("text").jsonPrimitive.content)
        assertEquals("turn_123", response.turnId)
        assertEquals("stream_456", response.streamId)
        assertEquals(AidenChatRole.USER, response.message.role)
        assertEquals(exactText, response.message.text)
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

            event: subagent_update
            id: 3
            data: {"protocolVersion":1,"streamId":"stream_test","sequence":3,"timestamp":"2026-08-24T00:00:02Z","type":"subagent_update","payload":{"childRunId":"run-private","childTranscript":["private child text"],"childResult":"private child result"}}

            event: done
            id: 4
            data: {"protocolVersion":1,"streamId":"stream_test","sequence":4,"timestamp":"2026-08-24T00:00:03Z","type":"done","payload":{"messageId":"msg_done"}}

        """.trimIndent()

        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody(sseBody)
                .setResponseCode(200)
        )

        val events = client.openStream("chat_1", "stream_test").toList()

        assertEquals(4, events.size)
        assertEquals(AidenRemoteEventType.TEXT_DELTA, events[0].type)
        assertEquals(AidenRemoteEventType.TEXT_DELTA, events[1].type)
        assertEquals("subagent_update", events[2].type.rawValue)
        assertFalse(events[2].shouldApply)
        assertNull(events[2].payload)
        assertEquals(AidenRemoteEventType.DONE, events[3].type)
        assertTrue(events[3].type.isTerminal)
        assertEquals(
            listOf(AidenRemoteEventType.TEXT_DELTA, AidenRemoteEventType.TEXT_DELTA, AidenRemoteEventType.DONE),
            events.filter { it.shouldApply }.map { it.type }
        )
    }

    @Test
    fun testStartTurnRejectsPrivateMetadataOutsideOpaqueParentText() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(202).setBody(
                """
                    {
                      "turnId":"turn-private",
                      "streamId":"stream-private",
                      "status":"running",
                      "message":{
                        "id":"message-private",
                        "role":"user",
                        "text":"Visible parent text",
                        "createdAt":"2026-08-25T18:00:00.000Z",
                        "child":{"providerCredential":"private material"}
                      }
                    }
                """.trimIndent()
            )
        )

        try {
            client.startTurn("chat_1", AidenTurnStart(text = "Visible parent text"))
            fail("Expected private response metadata to be rejected")
        } catch (error: AidenRemoteContractException.UnsafePayloadField) {
            assertEquals("providerCredential", error.field)
        }
    }

    @Test
    fun testEveryChatProjectionEndpointRejectsNormalizedNestedPrivateAliases() = runBlocking {
        data class EndpointCase(
            val alias: String,
            val status: Int,
            val method: String,
            val path: String,
            val call: suspend () -> Unit
        )

        val cases = listOf(
            EndpointCase("Reasoning_Content", 200, "GET", "/api/aiden/v1/chats") { client.chats() },
            EndpointCase("Tool-Arguments", 200, "GET", "/api/aiden/v1/chats/chat-private") { client.chat("chat-private") },
            EndpointCase("tool.result", 201, "POST", "/api/aiden/v1/chats") { client.createChat("workspace-private") },
            EndpointCase("S_e.c-r e t", 200, "PATCH", "/api/aiden/v1/chats/chat-private") {
                client.updateChat("chat-private", "revision-private", "Private")
            },
            EndpointCase("Reasoning_Content", 200, "POST", "/api/aiden/v1/chats/chat-private/move") {
                client.moveChat("chat-private", "revision-private", "workspace-private")
            },
            EndpointCase("Tool-Arguments", 202, "POST", "/api/aiden/v1/chats/chat-private/turns") {
                client.startTurn("chat-private", AidenTurnStart(text = "Visible parent text"))
            }
        )

        for (case in cases) {
            server.enqueue(
                MockResponse().setResponseCode(case.status).setBody(
                    """{"futurePublic":{"nested":{"${case.alias}":"private metadata"}}}"""
                )
            )
            try {
                case.call()
                fail("Expected ${case.alias} to be rejected for ${case.method} ${case.path}")
            } catch (error: AidenRemoteContractException.UnsafePayloadField) {
                assertEquals(case.alias, error.field)
            }
            val request = server.takeRequest()
            assertEquals(case.method, request.method)
            assertEquals(case.path, request.path)
        }
    }

    @Test
    fun testCancellingSSECollectorCancelsOkHttpCall() = runBlocking {
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody(": keep-alive\n".repeat(2_000))
                .throttleBody(1, 100, TimeUnit.MILLISECONDS)
                .setResponseCode(200)
        )

        val collector = launch { client.openStream("chat_1", "stream_cancel").collect() }
        yield()
        withTimeout(5_000) {
            while (server.requestCount == 0) delay(10)
        }
        assertEquals("/api/aiden/v1/streams/stream_cancel/events", server.takeRequest().path)
        collector.cancelAndJoin()

        repeat(20) {
            if (httpClient.dispatcher.runningCallsCount() == 0) return@repeat
            delay(25)
        }
        assertEquals(0, httpClient.dispatcher.runningCallsCount())
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

    @Test
    fun testMacSpeechStatusAndTranscriptionContract() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""
            {
              "engine":{"ready":true,"error":null},
              "selectedModelId":"parakeet-v3",
              "models":[{
                "id":"parakeet-v3","name":"Parakeet","description":"Local speech",
                "sizeLabel":"620 MB","languagesLabel":"25 languages",
                "recommended":true,"installed":true
              }],
              "input":{"encoding":"pcm_s16le","sampleRate":16000,"channels":1,"maximumSeconds":60,"partialResults":false}
            }
        """.trimIndent()))
        val status = client.speechStatus()
        assertTrue(status.engine.ready)
        assertFalse(status.input.partialResults)
        assertEquals("/api/aiden/v1/speech", server.takeRequest().path)

        server.enqueue(MockResponse().setResponseCode(200).setBody(
            """{"text":"Hello from the Mac","modelId":"parakeet-v3"}"""
        ))
        val result = client.transcribeSpeech("AAA=", "parakeet-v3")
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/aiden/v1/speech/transcriptions", request.path)
        assertTrue(request.body.readUtf8().contains("\"encoding\":\"pcm_s16le\""))
        assertEquals("Hello from the Mac", result.text)
    }

    @Test
    fun testAttachmentContentUsesAuthenticatedBoundedImageRequest() = runBlocking {
        val png = Base64.getDecoder().decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "image/png")
                .setBody(okio.Buffer().write(png))
        )

        val content = client.attachmentContent("chat-1", "image-1")
        val request = server.takeRequest()
        assertArrayEquals(png, content.data)
        assertEquals("image/png", content.mimeType)
        assertEquals("/api/aiden/v1/chats/chat-1/attachments/image-1/content", request.path)
        assertEquals("image/jpeg, image/png", request.getHeader("Accept"))
        assertEquals("Bearer test_credential_123", request.getHeader("Authorization"))
    }

    @Test
    fun testAttachmentContentRejectsUnsupportedMimeAndOversizedBodies() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(200).setHeader("Content-Type", "image/gif").setBody("GIF89a")
        )
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) {
            runBlocking { client.attachmentContent("chat-1", "gif-1") }
        }

        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "image/png")
                .setBody("x")
                .setHeader("Content-Length", AidenAttachmentImageValidation.MAXIMUM_BYTES + 1)
        )
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) {
            runBlocking { client.attachmentContent("chat-1", "large-1") }
        }
        Unit
    }
}
