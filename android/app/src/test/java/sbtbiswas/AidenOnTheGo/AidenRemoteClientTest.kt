package sbtbiswas.AidenOnTheGo

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Call
import okhttp3.EventListener
import okhttp3.ResponseBody
import okio.ForwardingSource
import okio.buffer
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.diagnostics.*
import sbtbiswas.AidenOnTheGo.features.chat.AidenChatForkErrors
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteRunEvent
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteEventType
import java.time.Instant
import java.util.Base64
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
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
    fun quietProgressResumeCarriesEpochAndReportsOpenWithoutASnapshot() = runBlocking {
        server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setHeader("Aiden-Progress-Resumed", "true"))
        val opened = AtomicBoolean(false)
        val events = client.progressEvents("chat-1", after = 42, epoch = "epoch-original", onOpen = { opened.set(it) }).toList()
        assertTrue(events.isEmpty())
        assertTrue(opened.get())
        val request = server.takeRequest()
        assertEquals("epoch-original", request.getHeader("Aiden-Progress-Epoch"))
        assertEquals("42", request.getHeader("Last-Event-ID"))
    }

    @Test
    fun conditionalReadsReuseBytesOnlyWithinTheSameCredentialClient() = runBlocking {
        val body = """{"protocolVersion":1,"instanceId":"test_instance","name":"Home","capabilities":["server:read"],"serverCapabilities":["server:read"],"appVersion":"1","connectionMode":"lan","serverTime":"2026-10-06T00:00:00Z"}"""
        server.enqueue(MockResponse().setBody(body).setHeader("ETag", "W/\"snapshot\""))
        server.enqueue(MockResponse().setResponseCode(304))
        assertEquals("Home", client.server().name)
        assertEquals("Home", client.server().name)
        assertNull(server.takeRequest().getHeader("If-None-Match"))
        assertEquals("W/\"snapshot\"", server.takeRequest().getHeader("If-None-Match"))
        val replacement = AidenRemoteClient(server.url("/api/aiden/v1").toString(), "replacement", httpClient)
        server.enqueue(MockResponse().setResponseCode(304))
        try { replacement.server(); fail("Unsolicited 304 must not recover another credential's cached bytes") } catch (_: AidenRemoteClientException.Server) { }
        assertNull(server.takeRequest().getHeader("If-None-Match"))
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
    fun providerCreationSendsExplicitVisionAndWriteOnlyKey() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"id":"custom:remote-fixture","label":"Private","models":["vision"]}"""))
        val key = UUID.fromString("10000000-0000-4000-8000-000000000001")
        val input = AidenProviderCreation("Private", "https://models.example.test/v1", needsKey = true,
            apiKey = "synthetic-provider-key", models = listOf(AidenProviderCreationModel("vision", vision = true)))
        assertTrue(input.isValid)
        assertFalse(input.toString().contains("synthetic-provider-key"))
        val receipt = client.createProvider(input, key)
        assertEquals(listOf("vision"), receipt.models)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/aiden/v1/providers", request.path)
        assertEquals(key.toString(), request.getHeader("Idempotency-Key"))
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals("true", body.getValue("confirmedForeground").jsonPrimitive.content)
        assertEquals("synthetic-provider-key", body.getValue("apiKey").jsonPrimitive.content)
        assertEquals("true", body.getValue("models").jsonArray[0].jsonObject.getValue("vision").jsonPrimitive.content)
        assertFalse(input.copy(baseUrl = "https://user:secret@example.test/v1").isValid)
        assertFalse(input.copy(models = emptyList()).isValid)
        assertFalse(input.copy(apiKey = "a".repeat(4097)).isValid)
        assertFalse(input.copy(baseUrl = "https://models.example.test/" + "a".repeat(2048)).isValid)
        assertFalse(input.copy(models = listOf(AidenProviderCreationModel("model\nnext"))).isValid)
        assertFalse(input.copy(label = "private\tname").isValid)
        assertTrue(input.copy(apiKey = "a".repeat(4096)).isValid)
        assertTrue(input.copy(needsKey = false, apiKey = null).isValid)
    }

    @Test
    fun testMemorySettingsUseRevisionCheckedForegroundMutation() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"enabled":true,"revision":"rev_memory_1"}""").setResponseCode(200))
        server.enqueue(MockResponse().setBody("""{"enabled":false,"revision":"rev_memory_2"}""").setResponseCode(200))

        val current = client.memorySettings()
        assertTrue(current.enabled)
        val getRequest = server.takeRequest()
        assertEquals("GET", getRequest.method)
        assertEquals("/api/aiden/v1/memory/settings", getRequest.path)

        val saved = client.updateMemorySettings(current.revision, false)
        assertFalse(saved.enabled)
        val patchRequest = server.takeRequest()
        assertEquals("PATCH", patchRequest.method)
        assertEquals("rev_memory_1", patchRequest.getHeader("If-Match"))
        val body = Json.parseToJsonElement(patchRequest.body.readUtf8()).jsonObject
        assertEquals(setOf("enabled", "confirmedForeground"), body.keys)
        assertEquals("false", body.getValue("enabled").jsonPrimitive.content)
        assertEquals("true", body.getValue("confirmedForeground").jsonPrimitive.content)
    }

    @Test
    fun testScheduledRunBindsRevisionAndIdempotencyKey() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(202).setBody(
                """
                {
                    "taskId": "task_1",
                    "runId": "run_1",
                    "status": "accepted",
                    "acceptedAt": "2026-08-30T12:00:00Z"
                }
                """.trimIndent()
            )
        )
        val key = UUID.fromString("11111111-1111-1111-1111-111111111111")

        val accepted = client.runScheduledTask("task_1", "rev_task_1", key)

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/aiden/v1/scheduled-tasks/task_1/run", request.path)
        assertEquals("rev_task_1", request.getHeader("If-Match"))
        assertEquals(key.toString(), request.getHeader("Idempotency-Key"))
        assertEquals("run_1", accepted.runId)
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
    fun testSSEStreamDiscardsUnterminatedDoneEvent() = runBlocking {
        val sseBody = """
            event: done
            id: 4
            data: {"protocolVersion":1,"streamId":"stream_test","sequence":4,"timestamp":"2026-09-19T00:00:00Z","type":"done","terminal":true,"payload":{"messageId":"msg_done"}}
        """.trimIndent() + "\n"
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody(sseBody)
        )

        assertTrue(client.openStream("chat_1", "stream_test", lastEventId = 3).toList().isEmpty())
        assertEquals("3", server.takeRequest().getHeader("Last-Event-ID"))
    }

    @Test
    fun testSSEStreamParsing() = runBlocking {
        val sseBody = """
            event: text_delta
            id: 1
            data: {"protocolVersion":1,"streamId":"stream_test","sequence":1,"timestamp":"2026-08-24T00:00:00Z","type":"text_delta","terminal":false,"payload":{"text":"Hello "}}

            event: text_delta
            id: 2
            data: {"protocolVersion":1,"streamId":"stream_test","sequence":2,"timestamp":"2026-08-24T00:00:01Z","type":"text_delta","terminal":false,"payload":{"text":"World!"}}

            event: subagent_update
            id: 3
            data: {"protocolVersion":1,"streamId":"stream_test","sequence":3,"timestamp":"2026-08-24T00:00:02Z","type":"subagent_update","terminal":false,"payload":{"childRunId":"run-private","childTranscript":["private child text"],"childResult":"private child result"}}

            event: done
            id: 4
            data: {"protocolVersion":1,"streamId":"stream_test","sequence":4,"timestamp":"2026-08-24T00:00:03Z","type":"done","terminal":true,"payload":{"messageId":"msg_done"}}

        """.trimIndent() + "\n\n"

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
    fun testChatProgressEndpointsUseScopedPathsAndHistoricalTurnQuery() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """
                {
                  "version":1,
                  "chatId":"chat_progress",
                  "availability":"ready",
                  "epoch":"epoch_progress",
                  "revision":3,
                  "updatedAt":"2026-08-24T00:00:00Z",
                  "tasks":[{"id":1,"subject":"Check progress","status":"in_progress"}]
                }
                """.trimIndent()
            )
        )
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """
                {
                  "version":1,
                  "chatId":"chat_progress",
                  "turnId":"turn_previous",
                  "previousTurns":[],
                  "availability":"ready",
                  "epoch":"epoch_progress",
                  "revision":4,
                  "updatedAt":"2026-08-24T00:00:00Z",
                  "agents":[]
                }
                """.trimIndent()
            )
        )

        val tasks = client.chatTasks("chat_progress")
        val taskRequest = server.takeRequest()
        val roster = client.chatAgents("chat_progress", "turn_previous")
        val rosterRequest = server.takeRequest()

        assertEquals("/api/aiden/v1/chats/chat_progress/tasks", taskRequest.path)
        assertEquals("/api/aiden/v1/chats/chat_progress/agents?turnId=turn_previous", rosterRequest.path)
        assertEquals(1, tasks.tasks.size)
        assertEquals("turn_previous", roster.turnId)
    }

    @Test
    fun testAgentInterruptPostsToTheAgentRouteAndReturnsTheStoppedRoster() = runBlocking {
        val fixtureRoot = Json.parseToJsonElement(
            javaClass.classLoader!!.getResource("contract.json")!!.readText()
        ).jsonObject
        val stoppedRoster = fixtureRoot.getValue("agentInterrupt").jsonObject.getValue("response").toString()
        server.enqueue(MockResponse().setResponseCode(200).setBody(stoppedRoster))
        server.enqueue(MockResponse().setResponseCode(200).setBody(stoppedRoster))

        val roster = client.interruptAgent("chat_fixture_01", "agent_fixture_01")
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/aiden/v1/chats/chat_fixture_01/agents/agent_fixture_01/interrupt", request.path)
        assertNull(request.getHeader("Idempotency-Key"))
        assertEquals(
            AidenChatAgentState.STOPPED,
            roster.agents.single { it.agentId == "agent_fixture_01" }.state
        )

        // A roster for another chat is rejected, and a malformed agent ID never
        // reaches the network.
        try {
            client.interruptAgent("chat_other", "agent_fixture_01")
            fail("Expected a roster for another chat to be rejected")
        } catch (_: AidenRemoteClientException.InvalidResponse) {
        }
        try {
            client.interruptAgent("chat_fixture_01", "agent/../escape")
            fail("Expected a malformed agent ID to be rejected")
        } catch (_: AidenRemoteClientException.InvalidResponse) {
        }
        assertEquals(2, server.requestCount)
    }

    @Test
    fun testProgressCapabilityUpgradePostsOnlyKnownGrantsAndRequiresCompleteResponse() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """
                {"capabilities":["chat:read","chat:write","bot:read","bot:write","tasks:read","agents:read","questions:respond","skills:invoke"]}
                """.trimIndent()
            )
        )

        val capabilities = client.updateDeviceCapabilities(
            listOf(AidenRemoteCapability.TASKS_READ, AidenRemoteCapability.AGENTS_READ)
        )
        val request = server.takeRequest()
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject

        assertEquals("POST", request.method)
        assertEquals("/api/aiden/v1/device/capabilities", request.path)
        assertEquals(
            listOf("tasks:read", "agents:read"),
            body.getValue("accepts").jsonArray.map { it.jsonPrimitive.content }
        )
        assertTrue(capabilities.containsAll(AidenRemoteCapability.PROGRESS))
    }

    @Test
    fun testStandaloneProgressStreamRequiresChatStreamIdentityAndDirectPayload() = runBlocking {
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "text/event-stream")
                .setBody(
                    """
                    event: task_update
                    id: 1
                    data: {"protocolVersion":1,"streamId":"chat_progress","sequence":1,"timestamp":"2026-08-24T00:00:00Z","type":"task_update","terminal":false,"payload":{"version":1,"chatId":"chat_progress","availability":"ready","epoch":"epoch_progress","revision":1,"updatedAt":"2026-08-24T00:00:00Z","tasks":[{"id":1,"subject":"Check progress","status":"completed"}]}}

                    """.trimIndent() + "\n\n"
                )
        )

        val events = client.progressEvents("chat_progress").toList()
        val request = server.takeRequest()

        assertEquals("/api/aiden/v1/chats/chat_progress/progress/events", request.path)
        assertEquals(1, events.size)
        assertEquals(AidenRemoteEventType.TASK_UPDATE, events.single().type)
        assertEquals(1, events.single().payload?.taskProgress?.tasks?.size)
        assertNull(events.single().payload?.agentRoster)
    }

    @Test
    fun testSSEChannelsRejectEventsFromTheOtherStream() = runBlocking {
        // The payload chatId intentionally matches the foreign streamId so the
        // event survives envelope parsing and reaches the channel check.
        val taskEvent = """
            event: task_update
            id: 1
            data: {"protocolVersion":1,"streamId":"stream_test","sequence":1,"timestamp":"2026-08-24T00:00:00Z","type":"task_update","terminal":false,"payload":{"version":1,"chatId":"stream_test","availability":"ready","epoch":"epoch_progress","revision":1,"updatedAt":"2026-08-24T00:00:00Z","tasks":[]}}

        """.trimIndent() + "\n\n"
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "text/event-stream")
                .setBody(taskEvent)
        )

        try {
            client.openStream("chat_1", "stream_test").toList()
            fail("Expected a progress event on the parent stream to be rejected")
        } catch (error: AidenRemoteContractException.ProtocolViolation) {
            assertTrue(error.message.orEmpty().contains("parent stream"))
        }
        assertEquals("/api/aiden/v1/streams/stream_test/events", server.takeRequest().path)

        val parentEvent = """
            event: text_delta
            id: 1
            data: {"protocolVersion":1,"streamId":"chat_progress","sequence":1,"timestamp":"2026-08-24T00:00:00Z","type":"text_delta","terminal":false,"payload":{"text":"parent text"}}

        """.trimIndent() + "\n\n"
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "text/event-stream")
                .setBody(parentEvent)
        )

        try {
            client.progressEvents("chat_progress").toList()
            fail("Expected a parent event on the chat progress stream to be rejected")
        } catch (error: AidenRemoteContractException.ProtocolViolation) {
            assertTrue(error.message.orEmpty().contains("chat progress stream"))
        }
        assertEquals("/api/aiden/v1/chats/chat_progress/progress/events", server.takeRequest().path)
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
    fun testBotCapabilityCatalogRoutesSavedChoicesToTheirBot() = runBlocking {
        val fixture = javaClass.classLoader!!.getResource("contract.json")!!.readText()
        val catalog = Json { ignoreUnknownKeys = true }.decodeFromString<AidenBotCapabilityCatalog>(
            Json.parseToJsonElement(fixture).jsonObject.getValue("botCapabilityCatalog").toString()
        )
        val disabled = catalog.copy(skillsEnabled = false, skills = catalog.skills.map { it.copy(available = false) })
        val generic = disabled.copy(skills = emptyList())
        server.enqueue(MockResponse().setBody(Json.encodeToString(generic)))
        server.enqueue(MockResponse().setBody(Json.encodeToString(disabled)))

        assertTrue(client.botCapabilityCatalog().skills.isEmpty())
        val genericRequest = server.takeRequest()
        assertEquals("/api/aiden/v1/bot-capabilities", genericRequest.path)

        val targeted = client.botCapabilityCatalog("bot_fixture_01")
        val targetRequest = server.takeRequest()
        assertEquals("GET", targetRequest.method)
        assertEquals("/api/aiden/v1/bot-capabilities?botId=bot_fixture_01", targetRequest.path)
        assertEquals("Bearer test_credential_123", targetRequest.getHeader("Authorization"))
        assertEquals(0L, targetRequest.bodySize)
        assertFalse(targeted.skillsEnabled)
        assertTrue(targeted.skills.isNotEmpty())
        assertEquals(disabled.skills, targeted.skills)
        assertTrue(targeted.skills.all { !it.available })
    }

    @Test
    fun testBotCapabilityCatalogRejectsUnsafeTargetsBeforeSending() = runBlocking {
        for (id in listOf("", "bot&botId=other", "../bot", "bot?extra=true", "a".repeat(161))) {
            try {
                client.botCapabilityCatalog(id)
                fail("Accepted invalid Bot ID: $id")
            } catch (_: sbtbiswas.AidenOnTheGo.protocol.AidenBotContractException) {
                // Validation must precede network access.
            }
        }
        assertEquals(0, server.requestCount)
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
        val diagnostics = mutableListOf<AidenDiagnosticRecord>()
        AidenDiagnostics.testSink = { diagnostics += it }
        try {
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
        assertEquals(2, diagnostics.count { it.event == AidenDiagnosticEvent.CONTRACT_REJECTED })
        } finally {
            AidenDiagnostics.testSink = null
        }
        Unit
    }

    @Test
    fun testRequestCancellationIsRecordedExactlyOnceAndNeverAsFailure() = runBlocking {
        val diagnostics = mutableListOf<AidenDiagnosticRecord>()
        AidenDiagnostics.testSink = { diagnostics += it }
        try {
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
            val request = launch(Dispatchers.IO) { client.server() }
            assertNotNull(server.takeRequest(2, TimeUnit.SECONDS))
            request.cancelAndJoin()
            assertEquals(diagnostics.map { it.message() }.joinToString(), 1, diagnostics.count {
                it.event == AidenDiagnosticEvent.REQUEST_FAILED &&
                    it.outcome == AidenDiagnosticOutcome.CANCELLED
            })
            assertEquals(0, diagnostics.count {
                it.event == AidenDiagnosticEvent.REQUEST_FAILED &&
                    it.outcome == AidenDiagnosticOutcome.FAILED
            })
        } finally {
            AidenDiagnostics.testSink = null
        }
    }

    @Test
    fun testCancellationDuringResponseBodyReadReleasesCallWithoutFailureDiagnostic() = runBlocking {
        val bodyStarted = CompletableDeferred<Unit>()
        val callReleased = CompletableDeferred<Unit>()
        val callCancelled = AtomicBoolean(false)
        val transport = httpClient.newBuilder()
            .readTimeout(4, TimeUnit.SECONDS)
            .addNetworkInterceptor { chain ->
                val response = chain.proceed(chain.request())
                val body = response.body!!
                val source = object : ForwardingSource(body.source()) {
                    override fun read(sink: okio.Buffer, byteCount: Long): Long {
                        bodyStarted.complete(Unit)
                        return super.read(sink, byteCount)
                    }
                }.buffer()
                response.newBuilder().body(object : ResponseBody() {
                    override fun contentType() = body.contentType()
                    override fun contentLength() = body.contentLength()
                    override fun source() = source
                }).build()
            }
            .eventListener(object : EventListener() {
                override fun canceled(call: Call) { callCancelled.set(true) }
                override fun callFailed(call: Call, ioe: java.io.IOException) { callReleased.complete(Unit) }
                override fun callEnd(call: Call) { callReleased.complete(Unit) }
            })
            .build()
        val slowClient = AidenRemoteClient(client.endpoint, client.credential, transport)
        val diagnostics = java.util.Collections.synchronizedList(mutableListOf<AidenDiagnosticRecord>())
        AidenDiagnostics.testSink = { diagnostics += it }
        server.enqueue(
            MockResponse().setBody(
                """{"protocolVersion":1,"instanceId":"test_instance","name":"Test Mac","capabilities":[],"appVersion":"1.0.0","connectionMode":"lan","serverTime":"2026-08-24T00:00:00Z"}"""
            ).setBodyDelay(3, TimeUnit.SECONDS)
        )
        val request = launch(Dispatchers.IO) { slowClient.server() }
        try {
            withTimeout(2_000) { bodyStarted.await() }
            withTimeout(1_000) {
                request.cancelAndJoin()
                callReleased.await()
            }
            assertTrue("Cancellation must reach the transport after headers", callCancelled.get())
            assertEquals(1, diagnostics.count {
                it.event == AidenDiagnosticEvent.REQUEST_FAILED && it.outcome == AidenDiagnosticOutcome.CANCELLED
            })
            assertEquals(0, diagnostics.count { it.outcome == AidenDiagnosticOutcome.FAILED })
        } finally {
            request.cancelAndJoin()
            AidenDiagnostics.testSink = null
        }
    }

    @Test
    fun testFiveStalledBodiesDoNotBlockAnotherRequestToTheSameHost() = runBlocking {
        val allBodiesStarted = CompletableDeferred<Unit>()
        val started = java.util.concurrent.atomic.AtomicInteger()
        val closed = java.util.concurrent.atomic.AtomicInteger()
        val transport = httpClient.newBuilder()
            .readTimeout(4, TimeUnit.SECONDS)
            .addNetworkInterceptor { chain ->
                val response = chain.proceed(chain.request())
                if (response.header("X-Stalled-Body") == null) return@addNetworkInterceptor response
                val body = response.body!!
                val source = object : ForwardingSource(body.source()) {
                    private var hasStarted = false
                    override fun read(sink: okio.Buffer, byteCount: Long): Long {
                        if (!hasStarted) {
                            hasStarted = true
                            if (started.incrementAndGet() == 5) allBodiesStarted.complete(Unit)
                        }
                        return super.read(sink, byteCount)
                    }
                    override fun close() {
                        closed.incrementAndGet()
                        super.close()
                    }
                }.buffer()
                response.newBuilder().body(object : ResponseBody() {
                    override fun contentType() = body.contentType()
                    override fun contentLength() = body.contentLength()
                    override fun source() = source
                }).build()
            }.build()
        assertEquals(5, transport.dispatcher.maxRequestsPerHost)
        val concurrentClient = AidenRemoteClient(client.endpoint, client.credential, transport)
        val body = """{"protocolVersion":1,"instanceId":"test_instance","name":"Test Mac","capabilities":[],"appVersion":"1.0.0","connectionMode":"lan","serverTime":"2026-08-24T00:00:00Z"}"""
        repeat(5) {
            server.enqueue(MockResponse().setHeader("X-Stalled-Body", "true")
                .setBody(body).setBodyDelay(3, TimeUnit.SECONDS))
        }
        val stalled = List(5) { launch(Dispatchers.IO) { concurrentClient.server() } }
        try {
            withTimeout(2_000) { allBodiesStarted.await() }
            server.enqueue(MockResponse().setBody(body))
            val fast = withTimeout(1_000) { concurrentClient.server() }
            assertEquals("Test Mac", fast.name)
            assertTrue("The slow bodies must still be pending", stalled.all { it.isActive })
        } finally {
            stalled.forEach { it.cancel() }
            stalled.forEach { it.join() }
        }
        assertEquals("All cancelled bodies must close", 5, closed.get())
    }

    @Test
    fun testDeclaredOversizedResponseClosesBodyBeforeRejectingPayload() = runBlocking {
        val bodyClosed = AtomicBoolean(false)
        val transport = httpClient.newBuilder().addInterceptor { chain ->
            val response = chain.proceed(chain.request())
            val originalBody = response.body!!
            val trackedSource = object : ForwardingSource(originalBody.source()) {
                override fun close() {
                    bodyClosed.set(true)
                    super.close()
                }
            }.buffer()
            response.newBuilder().body(object : ResponseBody() {
                override fun contentType() = originalBody.contentType()
                override fun contentLength() = Long.MAX_VALUE
                override fun source() = trackedSource
            }).build()
        }.build()
        val boundedClient = AidenRemoteClient(client.endpoint, client.credential, transport)
        server.enqueue(MockResponse().setBody("{}"))
        try {
            boundedClient.updateDeviceCapabilities(listOf(AidenRemoteCapability.TASKS_READ))
            fail("Expected declared oversized response to be rejected")
        } catch (_: AidenRemoteContractException.PayloadTooLarge) {
            assertTrue("Rejected bodies must release their connection", bodyClosed.get())
        }
    }

    @Test
    fun testHeaderTransportFailureIsRecordedExactlyOnce() = runBlocking {
        val diagnostics = mutableListOf<AidenDiagnosticRecord>()
        AidenDiagnostics.testSink = { diagnostics += it }
        try {
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
            assertThrows(Exception::class.java) { runBlocking { client.server() } }
            assertEquals(1, diagnostics.count {
                it.event == AidenDiagnosticEvent.REQUEST_FAILED &&
                    it.outcome == AidenDiagnosticOutcome.FAILED
            })
            assertEquals(0, diagnostics.count {
                it.event == AidenDiagnosticEvent.REQUEST_FAILED &&
                    it.outcome == AidenDiagnosticOutcome.CANCELLED
            })
        } finally {
            AidenDiagnostics.testSink = null
        }
    }

    @Test
    fun testApiBodyDisconnectIsRecordedExactlyOnceAsConnectionFailure() = runBlocking {
        val diagnostics = mutableListOf<AidenDiagnosticRecord>()
        AidenDiagnostics.testSink = { diagnostics += it }
        try {
            server.enqueue(
                MockResponse().setBody("x".repeat(64 * 1024))
                    .setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY)
            )
            assertThrows(java.io.IOException::class.java) { runBlocking { client.server() } }
            assertEquals(1, diagnostics.count {
                it.area == AidenDiagnosticArea.CONNECTION &&
                    it.event == AidenDiagnosticEvent.REQUEST_FAILED &&
                    it.outcome == AidenDiagnosticOutcome.FAILED
            })
            assertEquals(0, diagnostics.count { it.event == AidenDiagnosticEvent.CONTRACT_REJECTED })
        } finally {
            AidenDiagnostics.testSink = null
        }
    }

    @Test
    fun testAttachmentBodyDisconnectIsRecordedExactlyOnceAsConnectionFailure() = runBlocking {
        val diagnostics = mutableListOf<AidenDiagnosticRecord>()
        AidenDiagnostics.testSink = { diagnostics += it }
        try {
            server.enqueue(
                MockResponse()
                    .setResponseCode(200)
                    .setHeader("Content-Type", "image/png")
                    .setBody("x".repeat(64 * 1024))
                    .setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY)
            )
            assertThrows(Exception::class.java) {
                runBlocking { client.attachmentContent("chat-1", "disconnected-1") }
            }
            assertEquals(1, diagnostics.count {
                it.area == AidenDiagnosticArea.CONNECTION &&
                    it.event == AidenDiagnosticEvent.REQUEST_FAILED &&
                    it.outcome == AidenDiagnosticOutcome.FAILED &&
                    it.code == AidenDiagnosticCode.NETWORK
            })
            assertEquals(0, diagnostics.count {
                it.event == AidenDiagnosticEvent.CONTRACT_REJECTED
            })
        } finally {
            AidenDiagnostics.testSink = null
        }
    }

    // --- Contract revision 24: runs started on the Mac, in Telegram or by the scheduler ---

    @Test
    fun testPhoneRunCapabilitiesAreNegotiableButNeverInventedByTheMac() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(200).setBody(
            """{"capabilities":["chat:read","chat:write","bot:read","bot:write","runs:observe","runs:control"]}"""
        ))
        server.enqueue(MockResponse().setResponseCode(200).setBody(
            """{"capabilities":["chat:read","chat:write","bot:read","bot:write","runs:observe","runs:admin"]}"""
        ))

        val granted = client.updateDeviceCapabilities(
            listOf(AidenRemoteCapability.RUNS_OBSERVE, AidenRemoteCapability.RUNS_CONTROL)
        )
        assertTrue(granted.containsAll(AidenRemoteCapability.PHONE_RUNS))
        assertEquals(
            listOf("runs:observe", "runs:control"),
            Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
                .getValue("accepts").jsonArray.map { it.jsonPrimitive.content }
        )

        val failure = runCatching {
            client.updateDeviceCapabilities(listOf(AidenRemoteCapability.RUNS_OBSERVE))
        }.exceptionOrNull()
        assertNotNull("An unknown grant in the response must be rejected.", failure)
    }

    @Test
    fun testForeignRunControlUsesRunScopedRoutesBodiesAndIdempotencyKeys() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(202).setBody(
            """{"runId":"run-1","chatId":"chat-1","state":"running","cancelRequested":true}"""
        ))
        server.enqueue(MockResponse().setResponseCode(200).setBody(
            """{"runId":"run-1","approvalId":"approval-1","decision":"allow","scope":"chat","resolvedAt":"2026-10-05T10:00:00.000Z"}"""
        ))
        server.enqueue(MockResponse().setResponseCode(200).setBody(
            """{"runId":"run-1","approvalId":"approval-1","decision":"deny","resolvedAt":"2026-10-05T10:00:00.000Z"}"""
        ))
        server.enqueue(MockResponse().setResponseCode(200).setBody(
            """{"runId":"run-1","promptId":"prompt-1","outcome":"answered","resolvedAt":"2026-10-05T10:00:00.000Z"}"""
        ))
        server.enqueue(MockResponse().setResponseCode(409).setBody(
            """{"error":{"code":"approval_resolved","message":"Another controller already resolved this approval.","requestId":"r1","retryable":false,"details":{"decision":"allow","resolvedAt":"2026-10-05T10:00:00.000Z"}}}"""
        ))

        val cancelKey = UUID.randomUUID()
        assertTrue(client.cancelRun("run-1", cancelKey).cancelRequested)
        assertEquals(AidenApprovalScope.CHAT, client.respondToRunApproval("run-1", "approval-1", AidenApprovalDecision.ALLOW, AidenApprovalScope.CHAT).scope)
        assertEquals(AidenApprovalDecision.DENY, client.respondToRunApproval("run-1", "approval-1", AidenApprovalDecision.DENY, AidenApprovalScope.ALWAYS).decision)
        assertEquals("answered", client.respondToRunQuestion("run-1", "prompt-1", AidenQuestionRespondRequest(cancelled = true, answers = emptyList()), UUID.randomUUID()).outcome)

        val requests = (0 until 4).map { server.takeRequest() }
        assertEquals(
            listOf(
                "/api/aiden/v1/runs/run-1/cancel",
                "/api/aiden/v1/runs/run-1/approvals/approval-1/respond",
                "/api/aiden/v1/runs/run-1/approvals/approval-1/respond",
                "/api/aiden/v1/runs/run-1/questions/prompt-1/respond"
            ),
            requests.map { it.path }
        )
        assertTrue(requests.all { it.method == "POST" })
        assertEquals(cancelKey.toString().lowercase(), requests[0].getHeader("Idempotency-Key"))
        assertTrue(requests.all { request ->
            val key = request.getHeader("Idempotency-Key") ?: return@all false
            key == key.lowercase() && runCatching { UUID.fromString(key) }.isSuccess
        })
        assertEquals(emptyMap<String, Any>(), Json.parseToJsonElement(requests[0].body.readUtf8()).jsonObject)
        assertEquals("chat", Json.parseToJsonElement(requests[1].body.readUtf8()).jsonObject.getValue("scope").jsonPrimitive.content)
        // A deny never carries a remembered scope.
        assertEquals(setOf("decision"), Json.parseToJsonElement(requests[2].body.readUtf8()).jsonObject.keys)

        try {
            client.respondToRunApproval("run-1", "approval-2", AidenApprovalDecision.ALLOW)
            fail("A loser must surface the first-responder conflict.")
        } catch (error: AidenRemoteClientException.Server) {
            assertEquals("Answered on Mac: allowed", AidenForeignRunResolution.loser(error)?.notice)
        }
    }

    @Test
    fun testCurrentRunStreamAttachesToOneExternallyStartedRun() = runBlocking {
        fun frame(run: String, sequence: Int, type: String, payload: String): String =
            "id: $sequence\nevent: $type\ndata: {\"protocolVersion\":1,\"streamId\":\"$run\",\"sequence\":$sequence,\"timestamp\":\"2026-10-05T10:00:0${sequence}Z\",\"type\":\"$type\",\"terminal\":false,\"payload\":$payload}\n\n"
        val started = frame("run-mac", 1, "run.started", """{"runId":"run-mac","chatId":"chat-1","origin":"scheduler"}""")
        val text = frame("run-mac", 2, "text_delta", """{"text":"From the Mac"}""")
        server.enqueue(MockResponse().setResponseCode(200).setHeader("Content-Type", "text/event-stream").setBody(started + text))
        server.enqueue(
            MockResponse().setResponseCode(200).setHeader("Content-Type", "text/event-stream")
                .setBody(started + text + frame("run-other", 3, "text_delta", """{"text":"x"}"""))
        )

        val events = client.currentRunEvents("chat-1").toList()
        assertEquals(listOf("run-mac", "run-mac"), events.map { it.runId })
        assertEquals(AidenRemoteRunEvent.Kind.Started("chat-1", "scheduler"), events.first().kind)
        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/api/aiden/v1/chats/chat-1/runs/current/events", request.path)

        // A frame naming another run cannot slip into the attached run's feed.
        val received = mutableListOf<AidenRemoteRunEvent>()
        try {
            client.currentRunEvents("chat-1").collect { received.add(it) }
            fail("A second run identity must end the stream.")
        } catch (_: AidenRemoteContractException.InvalidStreamIdentity) {
        }
        assertEquals(2, received.size)
    }

    private fun contractFixture(): kotlinx.serialization.json.JsonObject = Json.parseToJsonElement(
        javaClass.classLoader!!.getResource("contract.json")!!.readText()
    ).jsonObject

    @Test
    fun testForkWithSummaryPostsTheFixtureRequestAndParsesThePendingFork() = runBlocking {
        val fixture = contractFixture().getValue("chatFork").jsonObject.getValue("fork").jsonObject
        server.enqueue(MockResponse().setResponseCode(201).setBody(fixture.getValue("response").toString()))
        val key = UUID.fromString("00000000-0000-4000-8000-000000000021")

        val result = client.forkChat(
            id = "chat_fixture_source_01",
            revision = "chat_revision_source_7",
            messageId = "message_fixture_source_assistant_01",
            position = AidenChatForkPosition.AFTER,
            withSummary = true,
            summaryFocus = "  the protocol decisions \n",
            idempotencyKey = key
        )
        val request = server.takeRequest()

        assertEquals("POST", request.method)
        assertEquals("/api/aiden/v1/chats/chat_fixture_source_01/fork", request.path)
        assertEquals("chat_revision_source_7", request.getHeader("If-Match"))
        assertEquals(key.toString(), request.getHeader("Idempotency-Key"))
        assertEquals(fixture.getValue("request"), Json.parseToJsonElement(request.body.readUtf8()))

        assertEquals("chat_fixture_fork_01", result.chat.id)
        assertNull(result.prefill)
        val lineage = result.chat.forkedFrom!!
        assertEquals("chat_fixture_source_01", lineage.chatId)
        assertEquals(AidenChatForkPosition.AFTER, lineage.position)
        val summary = lineage.summary!!
        assertEquals(AidenChatForkSummaryState.PENDING, summary.state)
        assertEquals("message_fixture_fork_assistant_01", summary.afterMessageId)
        assertEquals("the protocol decisions", summary.focus)
        assertTrue(summary.holdsTurns)
    }

    @Test
    fun testEditInForkOmitsTheSummaryAndReturnsThePrefill() = runBlocking {
        val fixture = contractFixture().getValue("chatFork").jsonObject.getValue("editFork").jsonObject
        server.enqueue(MockResponse().setResponseCode(201).setBody(fixture.getValue("response").toString()))

        val result = client.forkChat(
            id = "chat_fixture_source_01",
            revision = "chat_revision_source_7",
            messageId = "message_fixture_source_user_02",
            position = AidenChatForkPosition.BEFORE,
            summaryFocus = "ignored without a summary"
        )
        val request = server.takeRequest()

        assertEquals(fixture.getValue("request"), Json.parseToJsonElement(request.body.readUtf8()))
        assertNotNull(UUID.fromString(request.getHeader("Idempotency-Key")))
        assertNull(result.chat.forkedFrom!!.summary)
        assertEquals(AidenChatForkPosition.BEFORE, result.chat.forkedFrom!!.position)
        val prefill = result.prefill!!
        assertEquals("Now check the error codes.", prefill.text)
        assertEquals(listOf("codes.txt"), prefill.attachments.map { it.name })
    }

    @Test
    fun testForkWithBlankFocusAsksForAnUnfocusedSummary() = runBlocking {
        val response = contractFixture().getValue("chatFork").jsonObject.getValue("fork").jsonObject.getValue("response")
        server.enqueue(MockResponse().setResponseCode(201).setBody(response.toString()))

        client.forkChat(
            "chat_fixture_source_01", "chat_revision_source_7", "message_fixture_source_assistant_01",
            AidenChatForkPosition.AFTER, withSummary = true, summaryFocus = "   "
        )
        val body = Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject

        assertEquals(Json.parseToJsonElement("{}"), body.getValue("summary"))
    }

    @Test
    fun testForkRejectsAResponseThatIsTheSourceChat() = runBlocking {
        val response = contractFixture().getValue("chatFork").jsonObject.getValue("fork").jsonObject.getValue("response")
        server.enqueue(MockResponse().setResponseCode(201).setBody(response.toString()))

        try {
            client.forkChat("chat_fixture_fork_01", "rev", "message_fixture_source_assistant_01", AidenChatForkPosition.AFTER)
            fail("A fork must be a new chat")
        } catch (_: AidenRemoteClientException.InvalidResponse) {
        }
    }

    @Test
    fun testForkSummaryActionsPostToTheirRoutes() = runBlocking {
        val chatFork = contractFixture().getValue("chatFork").jsonObject
        val forkChat = chatFork.getValue("fork").jsonObject.getValue("response").jsonObject.getValue("chat").toString()
        server.enqueue(MockResponse().setResponseCode(200).setBody(forkChat))
        server.enqueue(MockResponse().setResponseCode(200).setBody(forkChat))
        server.enqueue(MockResponse().setResponseCode(200).setBody(chatFork.getValue("summaryCancel").toString()))

        assertEquals("chat_fixture_fork_01", client.retryForkSummary("chat_fixture_fork_01").id)
        assertEquals("chat_fixture_fork_01", client.skipForkSummary("chat_fixture_fork_01").id)
        assertTrue(client.cancelForkSummary("chat_fixture_fork_01").cancelled)

        val requests = List(3) { server.takeRequest() }
        assertEquals(listOf("POST", "POST", "POST"), requests.map { it.method })
        assertEquals(
            listOf(
                "/api/aiden/v1/chats/chat_fixture_fork_01/fork-summary/retry",
                "/api/aiden/v1/chats/chat_fixture_fork_01/fork-summary/skip",
                "/api/aiden/v1/chats/chat_fixture_fork_01/fork-summary/cancel"
            ),
            requests.map { it.path }
        )
    }

    @Test
    fun testFetchedForkDecodesEverySummaryState() = runBlocking {
        val chatFork = contractFixture().getValue("chatFork").jsonObject
        val forkChat = chatFork.getValue("fork").jsonObject.getValue("response").jsonObject.getValue("chat").jsonObject
        val lineage = forkChat.getValue("forkedFrom").jsonObject
        val pending = lineage.getValue("summary")
        val summaries = listOf(pending) + chatFork.getValue("summaryStates").jsonArray
        for (summary in summaries) {
            val chat = kotlinx.serialization.json.JsonObject(
                forkChat + ("forkedFrom" to kotlinx.serialization.json.JsonObject(lineage + ("summary" to summary)))
            )
            server.enqueue(MockResponse().setResponseCode(200).setBody(chat.toString()))
        }

        val decoded = summaries.map { client.chat("chat_fixture_fork_01").forkedFrom!!.summary!! }

        assertEquals(
            listOf(AidenChatForkSummaryState.PENDING, AidenChatForkSummaryState.READY, AidenChatForkSummaryState.FAILED),
            decoded.map { it.state }
        )
        assertTrue(decoded.all { it.afterMessageId == "message_fixture_fork_assistant_01" })
        assertTrue(decoded.all { it.focus == "the protocol decisions" })
        val (pendingSummary, ready, failed) = decoded
        assertNull(pendingSummary.text)
        assertNull(pendingSummary.error)
        assertEquals("The review settled on revision 21 and kept every route additive.", ready.text)
        assertNull(ready.error)
        assertFalse("A ready summary lets turns through", ready.holdsTurns)
        assertEquals("The summary could not be generated.", failed.error)
        assertNull(failed.text)
        assertTrue("A failed summary holds turns until retried or skipped", failed.holdsTurns)
    }

    @Test
    fun testForkErrorsExplainABusyOrChangedSource() = runBlocking {
        fun errorBody(code: String) =
            """{"error":{"code":"$code","message":"server text","requestId":"request-fork","retryable":false}}"""
        server.enqueue(MockResponse().setResponseCode(409).setBody(errorBody("operation_in_progress")))
        server.enqueue(MockResponse().setResponseCode(409).setBody(errorBody("revision_conflict")))

        val busy = runCatching {
            client.forkChat("chat_fixture_source_01", "rev", "message_fixture_source_assistant_01", AidenChatForkPosition.AFTER)
        }.exceptionOrNull()!!
        val changed = runCatching {
            client.forkChat("chat_fixture_source_01", "rev", "message_fixture_source_assistant_01", AidenChatForkPosition.AFTER)
        }.exceptionOrNull()!!

        assertFalse(AidenChatForkErrors.isRevisionConflict(busy))
        assertEquals("This chat is busy on your Mac. Try forking again in a moment.", AidenChatForkErrors.forkMessage(busy))
        assertTrue(AidenChatForkErrors.isRevisionConflict(changed))
        assertEquals(
            "This chat changed on your Mac. Check the latest messages and try again.",
            AidenChatForkErrors.forkMessage(changed)
        )
    }

    @Test
    fun testLineageIsOptionalAndSummaryRowsCarryOnlyTheLineage() = runBlocking {
        val fixture = contractFixture()
        // An older Mac's chat has no lineage.
        server.enqueue(MockResponse().setResponseCode(200).setBody(fixture.getValue("chat").toString()))
        val olderChat = client.chat(fixture.getValue("chat").jsonObject.getValue("id").jsonPrimitive.content)
        server.takeRequest()
        assertNull(olderChat.forkedFrom)

        val page = fixture.getValue("chatSummaries").jsonObject
        val rows = page.getValue("summaries").jsonArray
        val forkedRow = kotlinx.serialization.json.JsonObject(
            rows[0].jsonObject + (
                "forkedFrom" to Json.parseToJsonElement(
                    """{"chatId":"chat_fixture_source_01","messageId":"message_fixture_source_user_02","position":"before","at":"2026-08-18T19:06:00.000Z"}"""
                )
            )
        )
        val forkedPage = kotlinx.serialization.json.JsonObject(
            page + ("summaries" to kotlinx.serialization.json.JsonArray(listOf(forkedRow, rows[1])))
        )
        server.enqueue(MockResponse().setResponseCode(200).setBody(forkedPage.toString()))

        val summaries = client.chatSummaryPage().summaries
        assertEquals("chat_fixture_source_01", summaries[0].forkedFrom?.chatId)
        assertEquals(AidenChatForkPosition.BEFORE, summaries[0].forkedFrom?.position)
        assertNull(summaries[1].forkedFrom)
    }
}
