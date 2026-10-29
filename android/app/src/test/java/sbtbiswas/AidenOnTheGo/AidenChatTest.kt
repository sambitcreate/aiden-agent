package sbtbiswas.AidenOnTheGo

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.ViewModelStore
import java.io.File
import java.time.Instant
import java.util.Base64
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlinx.coroutines.isActive
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.features.chat.AidenChatForkEligibility
import sbtbiswas.AidenOnTheGo.features.chat.AidenChatScroll
import sbtbiswas.AidenOnTheGo.features.chat.AidenChatForkSource
import sbtbiswas.AidenOnTheGo.features.chat.AidenChatViewModel
import sbtbiswas.AidenOnTheGo.features.chat.AidenForeignRunAttachPolicy
import sbtbiswas.AidenOnTheGo.features.chat.AidenVisualSnapshotRefreshPolicy
import sbtbiswas.AidenOnTheGo.features.chat.aidenEligibleImageAttachments
import sbtbiswas.AidenOnTheGo.features.chat.aidenUnsupportedHtmlArtifacts
import sbtbiswas.AidenOnTheGo.features.chat.aidenVisibleMessageAttachments
import sbtbiswas.AidenOnTheGo.features.chat.aidenVisualDisplay
import sbtbiswas.AidenOnTheGo.features.chat.aidenVisualsWithRows
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.persistence.AidenChatDraftStore
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteProtocol

class AidenChatTest {
    @Test
    fun repeatedFailedRetryKeepsTheOriginalAndLaterDraftExactlyOnce() {
        assertEquals("First\n\nLater", AidenDraftSendReconciliation.failedDraft("First", "First\n\nLater"))
        assertEquals("First", AidenDraftSendReconciliation.failedDraft("First", "First"))
        assertEquals("First\n\nLater", AidenDraftSendReconciliation.failedDraft("First", "Later"))
    }

    @Test
    fun restoredRunInputRetryKeepsOriginalStreamAndLaterDraft() = assertSwitchedRunInputSettlement(false)

    @Test
    fun heldRunInputReceiptCannotClearAnotherRequestAfterSwitch() = assertSwitchedRunInputSettlement(true)

    private fun assertSwitchedRunInputSettlement(replacement: Boolean) {
        val root = kotlin.io.path.createTempDirectory("aiden-input-retry").toFile()
        val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val owners = ViewModelStore()
        val server = MockWebServer()
        val initial = sampleChat()
        val requests = java.util.concurrent.CopyOnWriteArrayList<RecordedRequest>()
        val arrived = CountDownLatch(1)
        val release = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.method == "POST") {
                    requests.add(request)
                    arrived.countDown()
                    check(release.await(8, TimeUnit.SECONDS))
                    return MockResponse().setBody("""{"streamId":"stream-original","chatId":"${initial.id}","turnId":"turn-original","mode":"queue","status":"rejected","reason":"run_not_active","committed":false}""")
                }
                return if (request.path == "/api/aiden/v1/chats/${initial.id}") MockResponse().setBody(json.encodeToString(initial)) else MockResponse().setResponseCode(404)
            }
        }
        server.start()
        Dispatchers.setMain(dispatcher)
        try {
            runBlocking(dispatcher) {
                val installations = AidenInstallationStore(root, InMemoryAidenSecureStore())
                installations.addInstallation(AidenPairingExchange(instanceId = "runinput", deviceId = "device-input", endpoint = server.url("/api/aiden/v1").toString(),
                    serverSpkiSha256 = "sha256/test", credential = "synthetic", capabilities = listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.CHAT_WRITE)), null)
                val drafts = AidenChatDraftStore(root)
                val key = UUID.randomUUID().toString()
                val session = drafts.beginSession("runinput", initial.id)
                drafts.savePendingSend(AidenChatDraftStore.PendingSend("device-input", AidenTurnStart("Original guidance"), key,
                    System.currentTimeMillis(), emptyList(), "stream-original", AidenStreamInputMode.QUEUE), session)
                val cache = AidenChatCache(root)
                val coordinator = AidenRemoteCoordinator(installations, root, cache, drafts, scope = CoroutineScope(dispatcher + Job().apply { cancel() }))
                coordinator.refreshClient()
                val model = AidenChatViewModel(initial.id, coordinator, cache, drafts, initial)
                owners.put("chat", model)
                withTimeout(5_000) { model.isLoading.first { !it } }
                model.updateDraft("Later draft")
                assertFalse(model.canSend)
                assertTrue(model.canRetrySend)
                model.send(retry = true)
                withContext(Dispatchers.IO) { check(arrived.await(5, TimeUnit.SECONDS)) }
                val replacementKey = UUID.randomUUID().toString()
                if (replacement) {
                    val newerSession = drafts.beginSession("runinput", initial.id)
                    drafts.savePendingSend(null, newerSession)
                    drafts.savePendingSend(AidenChatDraftStore.PendingSend("device-input", AidenTurnStart("Other request"), replacementKey, System.currentTimeMillis(), emptyList()), newerSession)
                }
                installations.setActiveInstallation(null)
                coordinator.refreshClient()
                release.countDown()
                withTimeout(5_000) { model.isSubmittingRunInput.first { !it } }
                assertEquals(1, requests.size)
                assertEquals("/api/aiden/v1/streams/stream-original/inputs", requests.single().path)
                assertEquals(key, requests.single().getHeader("Idempotency-Key"))
                val payload = json.parseToJsonElement(requests.single().body.readUtf8()).jsonObject
                assertEquals("Original guidance", payload["text"]!!.jsonPrimitive.content)
                assertEquals("queue", payload["mode"]!!.jsonPrimitive.content)
                assertEquals("Later draft", model.draft.value)
                val reopened = AidenChatDraftStore(root)
                assertEquals(if (replacement) replacementKey else null, reopened.loadPendingSend(reopened.beginSession("runinput", initial.id), "device-input")?.key)
            }
        } finally {
            runBlocking(dispatcher) { owners.clearAndJoin() }
            Dispatchers.resetMain(); dispatcher.close(); server.shutdown(); root.deleteRecursively()
        }
    }

    @Test
    fun chatKeepsLoadingWithThePairingsRefreshedClient() {
        val root = kotlin.io.path.createTempDirectory("aiden-client-refresh").toFile()
        val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val owners = ViewModelStore()
        val server = MockWebServer()
        val initial = sampleChat()
        val chatReads = java.util.concurrent.atomic.AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
                if (request.requestUrl!!.encodedPath == "/api/aiden/v1/chats/${initial.id}") {
                    chatReads.incrementAndGet()
                    MockResponse().setBody(json.encodeToString(initial))
                } else MockResponse().setResponseCode(404)
        }
        server.start()
        Dispatchers.setMain(dispatcher)
        try {
            runBlocking(dispatcher) {
                val installations = AidenInstallationStore(root, InMemoryAidenSecureStore())
                installations.addInstallation(AidenPairingExchange(instanceId = "refresh", deviceId = "device-refresh", endpoint = server.url("/api/aiden/v1").toString(),
                    serverSpkiSha256 = "sha256/test", credential = "synthetic", capabilities = listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.CHAT_WRITE)), null)
                val cache = AidenChatCache(root)
                val drafts = AidenChatDraftStore(root)
                val coordinator = AidenRemoteCoordinator(installations, root, cache, drafts, scope = CoroutineScope(dispatcher + Job().apply { cancel() }))
                coordinator.refreshClient()
                val model = AidenChatViewModel(initial.id, coordinator, cache, drafts, initial)
                owners.put("chat", model)
                withTimeout(5_000) { model.isLoading.first { !it } }
                withTimeout(5_000) { while (chatReads.get() < 1) yield() }
                val before = chatReads.get()
                check(model.isConnected) { "the chat is bound to the pairing's first client" }
                val errorBefore = model.presentedError.value

                // Retry after a failed connection gives the same pairing a new client object.
                val firstClient = coordinator.client.value
                coordinator.refreshClient()
                check(coordinator.client.value !== firstClient) { "refreshClient must make a new client for the same pairing" }
                withTimeout(5_000) { while (chatReads.get() <= before) yield() }
                withTimeout(5_000) { model.isLoading.first { !it } }
                check(model.isConnected) { "the chat sends and loads with the pairing's new client" }
                // The reread with the new client adds no error of its own.
                assertEquals(errorBefore, model.presentedError.value)

                // A removed pairing still takes the client away.
                installations.setActiveInstallation(null)
                coordinator.refreshClient()
                check(!model.isConnected) { "a removed pairing takes the client away" }
            }
        } finally {
            runBlocking(dispatcher) { owners.clearAndJoin() }
            Dispatchers.resetMain(); dispatcher.close(); server.shutdown(); root.deleteRecursively()
        }
    }

    @Test
    fun corruptPendingSendFailsClosedAndCannotOverwriteAnUnresolvedKey() {
        val root = kotlin.io.path.createTempDirectory("aiden-corrupt-attempt").toFile()
        try {
            val store = AidenChatDraftStore(root = root)
            val session = store.beginSession("mac", "chat")
            val pending = AidenChatDraftStore.PendingSend("device", AidenTurnStart("Once"), UUID.randomUUID().toString(), 1000, emptyList())
            store.savePendingSend(pending, session)
            try { store.savePendingSend(pending.copy(key = UUID.randomUUID().toString()), session); fail("Must retain the unresolved key") } catch (_: IllegalStateException) { }
            root.walkTopDown().first { it.name.endsWith(".attempt.json") }.writeText("broken")
            try { store.loadPendingSend(session, "device"); fail("Corruption must not mean absent") } catch (_: kotlinx.serialization.SerializationException) { }
            store.savePendingSend(null, session)
            assertNull(store.loadPendingSend(session, "device"))
        } finally { root.deleteRecursively() }
    }

    @Test
    fun pendingSendSurvivesRelaunchExpiresAndIsPurgedWithPairing() {
        val root = kotlin.io.path.createTempDirectory("aiden-attempt").toFile()
        try {
            val store = AidenChatDraftStore(root = root)
            val session = store.beginSession("mac", "chat")
            val attempt = AidenChatDraftStore.PendingSend("device", AidenTurnStart("Run once", "provider", "model"), UUID.randomUUID().toString(), 1000L, emptyList())
            store.savePendingSend(attempt, session)
            val reopened = AidenChatDraftStore(root = root)
            val next = reopened.beginSession("mac", "chat")
            val restored = reopened.loadPendingSend(next, "device")!!
            assertEquals(attempt.key, restored.key)
            assertEquals("Run once", restored.request.text)
            assertTrue(restored.canRetry(86_400_999L))
            assertFalse(restored.canRetry(86_401_000L))
            assertFalse(restored.canRetry(999L))
            assertNull(reopened.loadPendingSend(next, "replacement"))
            reopened.purge("mac")
            try { reopened.savePendingSend(attempt, next); fail("Retired pairing must not recreate an attempt") } catch (_: IllegalStateException) { }
            assertNull(reopened.loadPendingSend(reopened.beginSession("mac", "chat"), "device"))
        } finally { root.deleteRecursively() }
    }

    @Test
    fun workspaceCodemodeActivityKeepsParentAndNestedToolIdentitiesDistinct() {
        val payload = """{"version":3,"generationId":"generation-codemode","status":"completed","startedAt":1000,"finishedAt":2000,"steps":[{"id":"tool-1","order":0,"kind":"tool","toolCallId":"call-1","toolName":"codemode","label":"Codemode","status":"completed","startedAt":1000,"updatedAt":2000,"finishedAt":2000,"contentOffset":0},{"id":"tool-2","order":1,"kind":"tool","toolCallId":"call-2","toolName":"read_file","label":"Read file","status":"completed","startedAt":1100,"updatedAt":1200,"finishedAt":1200,"contentOffset":0}]}"""
        val timeline = json.decodeFromString<AidenGenerationTimeline>(payload)
        assertTrue(timeline.isRendererSafe())
        assertEquals(listOf("call-1", "call-2"), timeline.steps.map { it.toolCallId })
        assertEquals(listOf("codemode", "read_file"), timeline.steps.map { it.toolName })
        assertEquals(2, timeline.steps.map { it.id }.toSet().size)
    }

    @Test
    fun canonicalFixtureQuestionnaireRecapDecodesFromTheTimelineEvent() {
        val root = Json.parseToJsonElement(javaClass.classLoader!!.getResource("contract.json")!!.readText()).jsonObject
        val timelineEvent = root.getValue("events").jsonArray.map { it.jsonObject }
            .single { it.getValue("type").jsonPrimitive.content == "timeline" }
        val timeline = json.decodeFromJsonElement(
            AidenGenerationTimeline.serializer(),
            timelineEvent.getValue("payload").jsonObject.getValue("timeline"),
        )
        assertTrue(timeline.isRendererSafe())
        val recap = timeline.steps.firstNotNullOf { it.questionnaireRecap }
        assertEquals(AidenQuestionnaireRecap.Outcome.ANSWERED, recap.outcome)
        assertEquals(
            listOf(
                AidenQuestionnaireRecap.Answer.Choice("Plain text"),
                AidenQuestionnaireRecap.Answer.Unanswered(AidenQuestionnaireRecap.Outcome.ANSWERED),
            ),
            recap.items.map { recap.answer(it) },
        )
    }

    @Test
    fun canonicalFixtureWebExtractRecapDecodesFromTheTimelineEvent() {
        val root = Json.parseToJsonElement(javaClass.classLoader!!.getResource("contract.json")!!.readText()).jsonObject
        val timelineEvent = root.getValue("events").jsonArray.map { it.jsonObject }
            .single { it.getValue("type").jsonPrimitive.content == "timeline" }
        val timeline = json.decodeFromJsonElement(
            AidenGenerationTimeline.serializer(),
            timelineEvent.getValue("payload").jsonObject.getValue("timeline"),
        )
        val recap = timeline.steps.firstNotNullOf { it.extractionRecap }
        assertEquals("acme.example", recap.host)
        assertEquals(
            listOf(AidenWebExtractRecap.Status.EXTRACTED, AidenWebExtractRecap.Status.UNCERTAIN, AidenWebExtractRecap.Status.ABSENT),
            recap.fields.map { it.status },
        )
        assertEquals("Pro is \$20 per month, billed monthly.", recap.fields.first().sourceLine)
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun backgroundChatRefreshReportsReadOnlyAfterReturningToChat() {
        val directory = kotlin.io.path.createTempDirectory("aiden-visible-read-").toFile()
        val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val server = MockWebServer()
        val viewModels = ViewModelStore()
        val scopeJob = Job()
        val reports = java.util.concurrent.LinkedBlockingQueue<String>()
        val initial = AidenChat(
            id = "chat-read", workspaceId = "workspace-read", title = "Read boundary",
            messages = listOf(AidenChatMessage("reply-one", AidenChatRole.ASSISTANT, "First", createdAt = Instant.EPOCH)),
            createdAt = Instant.EPOCH, updatedAt = Instant.EPOCH, revision = "r1"
        )
        val remote = java.util.concurrent.atomic.AtomicReference(initial)
        val grants = listOf(AidenRemoteCapability.SERVER_READ, AidenRemoteCapability.CHAT_READ)
        val wireJson = Json(json) { explicitNulls = false }
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl!!.encodedPath) {
                "/api/aiden/v1/server" -> MockResponse().setBody("""{"protocolVersion":1,"instanceId":"instance-read","name":"Read Mac","appVersion":"1.0","capabilities":${json.encodeToString(grants)},"serverCapabilities":${json.encodeToString(grants)},"features":["chat-read-state-v1"],"connectionMode":"lan","serverTime":"2026-09-27T12:00:00Z"}""")
                "/api/aiden/v1/workspaces" -> MockResponse().setBody("""{"workspaces":[]}""")
                "/api/aiden/v1/chats/chat-read" -> MockResponse().setBody(wireJson.encodeToString(remote.get()))
                "/api/aiden/v1/chats/chat-read/read" -> {
                    reports.add(request.body.readUtf8())
                    MockResponse().setResponseCode(204)
                }
                else -> MockResponse().setResponseCode(404)
            }
        }
        server.start()
        Dispatchers.setMain(dispatcher)
        try {
            runBlocking(dispatcher) {
                val installations = AidenInstallationStore(directory, InMemoryAidenSecureStore())
                installations.addInstallation(AidenPairingExchange(
                    instanceId = "instance-read", deviceId = "device-read", endpoint = server.url("/api/aiden/v1").toString(),
                    serverSpkiSha256 = "sha256/test", credential = "synthetic", capabilities = grants
                ), null)
                val cache = AidenChatCache(directory)
                val drafts = AidenChatDraftStore(directory)
                val coordinator = AidenRemoteCoordinator(installations, directory, cache, drafts, scope = CoroutineScope(dispatcher + scopeJob))
                coordinator.refreshClient()
                withTimeout(5_000) { coordinator.serverInfo.first { it != null } }
                val model = AidenChatViewModel(initial.id, coordinator, cache, drafts, initial)
                viewModels.put("read", model)
                withTimeout(5_000) { model.isLoading.first { !it } }
                assertNull(withContext(Dispatchers.IO) { reports.poll(200, TimeUnit.MILLISECONDS) })
                model.setChatForegrounded(true)
                val first = withContext(Dispatchers.IO) { reports.poll(5, TimeUnit.SECONDS) }
                assertEquals("reply-one", json.parseToJsonElement(first!!).jsonObject["throughMessageId"]!!.jsonPrimitive.content)
                model.setChatForegrounded(false)
                remote.set(initial.copy(revision = "r2", messages = initial.messages + AidenChatMessage(
                    "reply-two", AidenChatRole.ASSISTANT, "Unseen", createdAt = Instant.EPOCH
                )))
                model.loadChat()
                withTimeout(5_000) { model.chat.first { it?.revision == "r2" } }
                assertNull(withContext(Dispatchers.IO) { reports.poll(200, TimeUnit.MILLISECONDS) })
                model.setChatForegrounded(true)
                val second = withContext(Dispatchers.IO) { reports.poll(5, TimeUnit.SECONDS) }
                assertEquals("reply-two", json.parseToJsonElement(second!!).jsonObject["throughMessageId"]!!.jsonPrimitive.content)
                model.setChatForegrounded(true)
                assertNull(withContext(Dispatchers.IO) { reports.poll(200, TimeUnit.MILLISECONDS) })
                viewModels.clearAndJoin()
            }
        } finally {
            scopeJob.cancel()
            Dispatchers.resetMain()
            dispatcher.close()
            server.shutdown()
            directory.deleteRecursively()
        }
    }

    @Test
    fun snapshotStoredAfterTheReplySettlesAppearsWithoutUserAction() = assertLateSnapshotRefresh(snapshotArrives = true)

    @Test
    fun snapshotThatNeverArrivesStopsRefetchingAfterThreeTries() = assertLateSnapshotRefresh(snapshotArrives = false)

    @Test
    fun snapshotStoredAfterAStreamedTurnSettlesAppearsWithoutUserAction() {
        val directory = kotlin.io.path.createTempDirectory("aiden-stream-snapshot-").toFile()
        val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val server = MockWebServer()
        val viewModels = ViewModelStore()
        val wireJson = Json(json) { explicitNulls = false }
        val initial = AidenChat(
            id = "chat-stream", workspaceId = "workspace-stream", title = "Plans",
            messages = emptyList(), createdAt = Instant.EPOCH, updatedAt = Instant.EPOCH, revision = "r0"
        )
        val question = AidenChatMessage("question-1", AidenChatRole.USER, "Compare plans", createdAt = Instant.now())
        val snapshot = AidenMessageAttachment(
            "visual-snapshot_${"5".repeat(64)}", "Plan options.png", "image/png", AidenAttachmentKind.IMAGE, 2_048
        )
        val reply = AidenChatMessage(
            "reply-1", AidenChatRole.ASSISTANT, "Here are the plans.",
            visuals = listOf(AidenChatVisual(
                id = "ui_plans", kind = "ui", title = "Plan options",
                fallbackText = "Solo or team", snapshotAttachmentId = snapshot.id
            )),
            createdAt = Instant.now()
        )
        // The terminal read lands before capture; the snapshot is stored only once the phone has settled.
        val settled = initial.copy(revision = "r1", messages = listOf(question, reply))
        val captured = initial.copy(revision = "r2", messages = listOf(question, reply.copy(attachments = listOf(snapshot))))
        val remote = java.util.concurrent.atomic.AtomicReference(initial)
        val turnStarted = java.util.concurrent.atomic.AtomicBoolean(false)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                return when {
                    path == "/api/aiden/v1/chats/chat-stream/turns" -> {
                        turnStarted.set(true)
                        remote.set(settled)
                        MockResponse().setResponseCode(202).setBody(
                            """{"turnId":"turn-1","streamId":"stream-1","status":"queued","message":${wireJson.encodeToString(question)}}"""
                        )
                    }
                    path == "/api/aiden/v1/chats/chat-stream" -> MockResponse().setBody(wireJson.encodeToString(remote.get()))
                    path == "/api/aiden/v1/streams/stream-1/events" -> MockResponse().setHeader("Content-Type", "text/event-stream").setBody(
                        "id: 1\nevent: done\ndata: {\"protocolVersion\":1,\"streamId\":\"stream-1\",\"sequence\":1," +
                            "\"timestamp\":\"2026-09-22T12:00:00Z\",\"type\":\"done\",\"terminal\":true,\"payload\":{\"messageId\":\"reply-1\"}}\n\n"
                    )
                    path == "/api/aiden/v1/streams/stream-1" -> MockResponse().setBody(
                        """{"streamId":"stream-1","chatId":"chat-stream","turnId":"turn-1","state":"done","lastSequence":1,"updatedAt":"2026-09-22T12:00:00Z"}"""
                    )
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        Dispatchers.setMain(dispatcher)
        try {
            runBlocking(dispatcher) {
                val grants = listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.CHAT_WRITE)
                val installations = AidenInstallationStore(directory, InMemoryAidenSecureStore())
                installations.addInstallation(AidenPairingExchange(
                    instanceId = "instance-stream", deviceId = "device-stream", endpoint = server.url("/api/aiden/v1").toString(),
                    serverSpkiSha256 = "sha256/test", credential = "synthetic", capabilities = grants
                ), null)
                val cache = AidenChatCache(directory)
                val drafts = AidenChatDraftStore(directory)
                // The production client binding without unrelated /server refresh work.
                val coordinator = AidenRemoteCoordinator(
                    installations, directory, cache, drafts, scope = CoroutineScope(dispatcher + Job().apply { cancel() })
                )
                coordinator.refreshClient()
                val model = AidenChatViewModel(
                    initial.id, coordinator, cache, drafts, initial,
                    visualSnapshotRefresh = AidenVisualSnapshotRefreshPolicy(delaysMillis = listOf(300L, 300L, 300L))
                )
                viewModels.put("stream", model)
                yield()
                withTimeout(5_000) { model.isLoading.first { !it } }
                model.updateDraft("Compare plans")
                assertTrue(model.canSend)
                model.send()
                // The streamed turn reaches its terminal event and settles on the snapshot-less transcript.
                withTimeout(5_000) { while (!turnStarted.get()) kotlinx.coroutines.delay(10) }
                withTimeout(5_000) {
                    while (model.chat.value?.revision != "r1" || model.hasActiveStream.value || model.isStarting.value) {
                        kotlinx.coroutines.delay(10)
                    }
                }
                assertNull(aidenVisualDisplay(reply.visuals!!.single(), model.chat.value!!.messages.last().attachments.orEmpty()).snapshot)
                // Capture finishes on the Mac; nothing on the phone asks for it.
                remote.set(captured)
                val shown = withTimeout(5_000) { model.chat.first { it?.revision == "r2" } }!!
                val message = shown.messages.last()
                assertEquals(snapshot, aidenVisualDisplay(message.visuals!!.single(), message.attachments.orEmpty()).snapshot)
                viewModels.clearAndJoin()
            }
        } finally {
            Dispatchers.resetMain()
            dispatcher.close()
            server.shutdown()
            directory.deleteRecursively()
        }
    }

    private fun assertLateSnapshotRefresh(snapshotArrives: Boolean) {
        val directory = kotlin.io.path.createTempDirectory("aiden-late-snapshot-").toFile()
        val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val server = MockWebServer()
        val viewModels = ViewModelStore()
        val scopeJob = Job()
        val snapshot = AidenMessageAttachment(
            "visual-snapshot_${"4".repeat(64)}", "Plan options.png", "image/png", AidenAttachmentKind.IMAGE, 2_048
        )
        val reply = AidenChatMessage(
            "reply-visual", AidenChatRole.ASSISTANT, "Here are the plans.",
            visuals = listOf(AidenChatVisual(
                id = "ui_plans", kind = "ui", title = "Plan options",
                fallbackText = "Solo or team", snapshotAttachmentId = snapshot.id
            )),
            createdAt = Instant.now()
        )
        // The Mac settles the reply before its snapshot capture finishes.
        val settled = AidenChat(
            id = "chat-visual", workspaceId = "workspace-visual", title = "Plans", messages = listOf(reply),
            createdAt = Instant.EPOCH, updatedAt = Instant.EPOCH, revision = "r1"
        )
        val captured = settled.copy(revision = "r2", messages = listOf(reply.copy(attachments = listOf(snapshot))))
        val fetches = java.util.concurrent.atomic.AtomicInteger(0)
        val grants = listOf(AidenRemoteCapability.SERVER_READ, AidenRemoteCapability.CHAT_READ)
        val wireJson = Json(json) { explicitNulls = false }
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl!!.encodedPath) {
                "/api/aiden/v1/server" -> MockResponse().setBody("""{"protocolVersion":1,"instanceId":"instance-visual","name":"Visual Mac","appVersion":"1.0","capabilities":${json.encodeToString(grants)},"serverCapabilities":${json.encodeToString(grants)},"features":["chat-visuals-v1"],"connectionMode":"lan","serverTime":"2026-09-27T12:00:00Z"}""")
                "/api/aiden/v1/workspaces" -> MockResponse().setBody("""{"workspaces":[]}""")
                "/api/aiden/v1/chats/chat-visual" -> {
                    // The first read lands before the snapshot is stored; later reads see it when it exists.
                    val served = if (fetches.incrementAndGet() > 1 && snapshotArrives) captured else settled
                    MockResponse().setBody(wireJson.encodeToString(served))
                }
                else -> MockResponse().setResponseCode(404)
            }
        }
        server.start()
        Dispatchers.setMain(dispatcher)
        try {
            runBlocking(dispatcher) {
                val installations = AidenInstallationStore(directory, InMemoryAidenSecureStore())
                installations.addInstallation(AidenPairingExchange(
                    instanceId = "instance-visual", deviceId = "device-visual", endpoint = server.url("/api/aiden/v1").toString(),
                    serverSpkiSha256 = "sha256/test", credential = "synthetic", capabilities = grants
                ), null)
                val cache = AidenChatCache(directory)
                val drafts = AidenChatDraftStore(directory)
                val coordinator = AidenRemoteCoordinator(installations, directory, cache, drafts, scope = CoroutineScope(dispatcher + scopeJob))
                coordinator.refreshClient()
                withTimeout(5_000) { coordinator.serverInfo.first { it != null } }
                val model = AidenChatViewModel(
                    settled.id, coordinator, cache, drafts, settled,
                    visualSnapshotRefresh = AidenVisualSnapshotRefreshPolicy(delaysMillis = listOf(50L, 50L, 50L))
                )
                viewModels.put("visual", model)
                if (snapshotArrives) {
                    val shown = withTimeout(5_000) { model.chat.first { it?.revision == "r2" } }!!
                    val message = shown.messages.single()
                    assertEquals(snapshot, aidenVisualDisplay(message.visuals!!.single(), message.attachments.orEmpty()).snapshot)
                    val afterSnapshot = fetches.get()
                    kotlinx.coroutines.delay(400)
                    assertEquals("refetching stops once every visual has its snapshot", afterSnapshot, fetches.get())
                } else {
                    withTimeout(5_000) { while (fetches.get() < 4) kotlinx.coroutines.delay(20) }
                    kotlinx.coroutines.delay(400)
                    assertEquals("the initial read plus three bounded retries", 4, fetches.get())
                    assertEquals("r1", model.chat.value?.revision)
                }
                viewModels.clearAndJoin()
            }
        } finally {
            scopeJob.cancel()
            Dispatchers.resetMain()
            dispatcher.close()
            server.shutdown()
            directory.deleteRecursively()
        }
    }

    // clear() requests cancellation; children can still resume on Main to finish cleanup.
    // A cancelled test caller must finish this barrier before disposing shared resources.
    private suspend fun ViewModelStore.clearAndJoin() = withContext(NonCancellable) {
        val jobs = keys().mapNotNull { get(it)?.viewModelScope?.coroutineContext?.get(Job) }
        clear()
        jobs.forEach { it.join() }
    }

    private fun runFrame(sequence: Int, type: String, payload: String, terminal: Boolean = false): String =
        "id: $sequence\nevent: $type\ndata: {\"protocolVersion\":1,\"streamId\":\"run-mac\",\"sequence\":$sequence," +
            "\"timestamp\":\"2026-10-05T10:00:00Z\",\"type\":\"$type\",\"terminal\":$terminal,\"payload\":$payload}\n\n"

    private fun runFeed(body: String): MockResponse =
        MockResponse().setHeader("Content-Type", "text/event-stream").setBody(body)

    /** A paired phone with the revision 24 run grants, viewing chat-mac whose run
     * was started on the Mac. [route] answers every path but /server. */
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private fun withForeignRunChat(
        initial: AidenChat?,
        route: (String, RecordedRequest) -> MockResponse,
        agentsRead: Boolean = false,
        attach: AidenForeignRunAttachPolicy = AidenForeignRunAttachPolicy(),
        features: List<String> = listOf("phone-run-control-v1"),
        body: suspend CoroutineScope.(AidenChatViewModel) -> Unit
    ) {
        val directory = kotlin.io.path.createTempDirectory("aiden-foreign-run-").toFile()
        val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val server = MockWebServer()
        val viewModels = ViewModelStore()
        val scopeJob = Job()
        val grants = listOf(
            AidenRemoteCapability.SERVER_READ, AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.CHAT_WRITE,
            AidenRemoteCapability.APPROVAL_RESPOND, AidenRemoteCapability.RUNS_OBSERVE, AidenRemoteCapability.RUNS_CONTROL
        ) + if (agentsRead) listOf(AidenRemoteCapability.AGENTS_READ) else emptyList()
        val serverFeatures = features + if (agentsRead) listOf("chat-agents-v1") else emptyList()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (val path = request.requestUrl!!.encodedPath) {
                "/api/aiden/v1/server" -> MockResponse().setBody("""{"protocolVersion":1,"instanceId":"instance-run","name":"Run Mac","appVersion":"1.0","capabilities":${json.encodeToString(grants)},"serverCapabilities":${json.encodeToString(grants)},"features":${json.encodeToString(serverFeatures)},"connectionMode":"lan","serverTime":"2026-10-05T10:00:00Z"}""")
                else -> route(path.removePrefix("/api/aiden/v1"), request)
            }
        }
        server.start()
        Dispatchers.setMain(dispatcher)
        try {
            runBlocking(dispatcher) {
                val installations = AidenInstallationStore(directory, InMemoryAidenSecureStore())
                installations.addInstallation(AidenPairingExchange(
                    instanceId = "instance-run", deviceId = "device-run", endpoint = server.url("/api/aiden/v1").toString(),
                    serverSpkiSha256 = "sha256/test", credential = "synthetic", capabilities = grants
                ), null)
                val cache = AidenChatCache(directory)
                val drafts = AidenChatDraftStore(directory)
                val coordinator = AidenRemoteCoordinator(installations, directory, cache, drafts, scope = CoroutineScope(dispatcher + scopeJob))
                coordinator.refreshClient()
                withTimeout(5_000) { coordinator.serverInfo.first { it != null } }
                val model = AidenChatViewModel("chat-mac", coordinator, cache, drafts, initial, foreignRunAttach = attach)
                viewModels.put("foreign", model)
                try {
                    body(model)
                } finally {
                    viewModels.clearAndJoin()
                }
            }
        } finally {
            scopeJob.cancel()
            Dispatchers.resetMain()
            dispatcher.close()
            server.shutdown()
            directory.deleteRecursively()
        }
    }

    private fun foreignRunChat(messages: List<AidenChatMessage> = emptyList()) = AidenChat(
        id = "chat-mac", workspaceId = "workspace-run", title = "Started on the Mac", messages = messages,
        createdAt = Instant.EPOCH, updatedAt = Instant.EPOCH, revision = "r${messages.size + 1}"
    )

    @Test
    fun endedReplayAfterTheOpeningReadRecoversTheFinalAnswerWithoutShowingHistoricalOutput() {
        val wireJson = Json(json) { explicitNulls = false }
        val ended = java.util.concurrent.atomic.AtomicBoolean(false)
        val reads = java.util.concurrent.atomic.AtomicInteger()
        val answer = AidenChatMessage("reply-mac", AidenChatRole.ASSISTANT, "Finished on the Mac", createdAt = Instant.EPOCH)
        withForeignRunChat(initial = foreignRunChat(), route = { path, _ ->
            when (path) {
                "/chats/chat-mac" -> {
                    val read = reads.incrementAndGet()
                    if (ended.get() && read == 2) MockResponse().setResponseCode(503)
                    else MockResponse().setBody(wireJson.encodeToString(
                        foreignRunChat(if (ended.get()) listOf(answer) else emptyList())
                    ))
                }
                "/chats/chat-mac/runs/current/events" -> {
                    ended.set(true)
                    runFeed(
                        runFrame(1, "run.started", """{"runId":"run-mac","chatId":"chat-mac","origin":"renderer"}""") +
                            runFrame(2, "done", """{"messageId":"reply-mac"}""", terminal = true) +
                            runFrame(2, "run.ended", """{"runId":"run-mac","chatId":"chat-mac","state":"done"}""", terminal = true)
                    )
                }
                else -> MockResponse().setResponseCode(404)
            }
        }) { model ->
            withTimeout(5_000) { model.isLoading.first { !it } }
            assertEquals("The opening transcript predates completion", 1, reads.get())
            model.startProgressObservation()
            withTimeout(10_000) { model.chat.first { it?.messages?.any { message -> message.id == "reply-mac" } == true } }
            assertTrue("A failed terminal read must recover automatically", reads.get() >= 3)
            assertEquals(listOf("reply-mac"), model.chat.value?.messages?.map { it.id })
            assertEquals("Finished on the Mac", model.chat.value?.messages?.single()?.text)
            assertEquals("", model.liveText.value)
            assertFalse(model.canStopCurrentRun)
        }
    }

    @Test
    fun transientFailureBeforeFirstRunEventRetriesTheCurrentRunRoute() {
        val wireJson = Json(json) { explicitNulls = false }
        val attempts = java.util.concurrent.atomic.AtomicInteger()
        withForeignRunChat(initial = foreignRunChat(), route = { path, _ ->
            when (path) {
                "/chats/chat-mac" -> MockResponse().setBody(wireJson.encodeToString(foreignRunChat()))
                "/chats/chat-mac/runs/current/events" -> {
                    if (attempts.incrementAndGet() == 1) MockResponse().setResponseCode(503)
                    else runFeed(
                        runFrame(1, "run.started", """{"runId":"run-mac","chatId":"chat-mac","origin":"renderer"}""") +
                            runFrame(2, "text_delta", """{"text":"Live after retry"}""")
                    )
                }
                "/runs/run-mac/events" -> runFeed("").setHeadersDelay(5, TimeUnit.SECONDS)
                else -> MockResponse().setResponseCode(404)
            }
        }) { model ->
            withTimeout(5_000) { model.isLoading.first { !it } }
            model.startProgressObservation()
            withTimeout(7_000) { model.liveText.first { it == "Live after retry" } }
            assertEquals(2, attempts.get())
            assertTrue(model.canStopCurrentRun)
        }
    }

    @Test
    fun foreignRunReplayAndLiveBurstAreCompleteBeforeAToolControlAppears() {
        val wireJson = Json(json) { explicitNulls = false }
        val releaseLiveBurst = CountDownLatch(1)
        val liveFeedRequested = CountDownLatch(1)
        val afterCursor = java.util.concurrent.atomic.AtomicReference<String?>()
        val liveFeeds = java.util.concurrent.atomic.AtomicInteger()
        val burst = (0 until 120).joinToString("") { index ->
            runFrame(index + 5, "text_delta", """{"text":"word "}""")
        }
        withForeignRunChat(initial = foreignRunChat(), route = { path, request ->
            when (path) {
                "/chats/chat-mac" -> MockResponse().setBody(wireJson.encodeToString(foreignRunChat()))
                "/chats/chat-mac/runs/current/events" -> runFeed(
                    runFrame(1, "run.started", """{"runId":"run-mac","chatId":"chat-mac","origin":"renderer"}""") +
                        runFrame(2, "text_delta", """{"text":"prefix "}""") +
                        runFrame(3, "reasoning_delta", """{"text":"first thought"}""")
                )
                "/runs/run-mac/events" -> {
                    if (liveFeeds.incrementAndGet() == 1) {
                        afterCursor.set(request.requestUrl?.queryParameter("after"))
                        liveFeedRequested.countDown()
                        releaseLiveBurst.await(10, TimeUnit.SECONDS)
                        runFeed(
                            runFrame(4, "reasoning_delta", """{"text":" and next"}""") + burst +
                                runFrame(125, "tool_started", """{"toolId":"tool-1","name":"run_command"}""")
                        )
                    } else runFeed("").setHeadersDelay(5, TimeUnit.SECONDS)
                }
                else -> MockResponse().setResponseCode(404)
            }
        }) { model ->
            try {
                withTimeout(5_000) { model.isLoading.first { !it } }
                model.startProgressObservation()
                assertTrue(withContext(Dispatchers.IO) { liveFeedRequested.await(5, TimeUnit.SECONDS) })
                withTimeout(5_000) { model.liveText.first { it == "prefix " } }
                assertEquals("first thought", model.reasoning.value)
                assertEquals("3", afterCursor.get())

                releaseLiveBurst.countDown()
                withTimeout(5_000) { model.tools.first { it.any { tool -> tool.id == "tool-1" } } }
                assertEquals("prefix " + "word ".repeat(120), model.liveText.value)
                assertEquals("first thought and next", model.reasoning.value)
                assertTrue(model.canStopCurrentRun)
            } finally {
                releaseLiveBurst.countDown()
            }
        }
    }

    @Test
    fun foreignRunGapSnapshotDropsPublishedAndQueuedOutputBeforeNewDeltas() {
        val wireJson = Json(json) { explicitNulls = false }
        val releaseGap = CountDownLatch(1)
        val gapRequested = CountDownLatch(1)
        val resumedFeeds = java.util.concurrent.atomic.AtomicInteger()
        val snapshot = """{"runId":"run-mac","chatId":"chat-mac","reason":"gap","epoch":"epoch-2","state":"running","pendingApprovalIds":[],"pendingQuestionIds":[],"approvals":[],"questions":[],"nextSequence":1}"""
        withForeignRunChat(initial = foreignRunChat(), route = { path, _ ->
            when (path) {
                "/chats/chat-mac" -> MockResponse().setBody(wireJson.encodeToString(foreignRunChat()))
                "/chats/chat-mac/runs/current/events" -> runFeed(
                    runFrame(1, "run.started", """{"runId":"run-mac","chatId":"chat-mac","origin":"renderer"}""") +
                        runFrame(2, "text_delta", """{"text":"old prefix "}""")
                )
                "/runs/run-mac/events" -> {
                    if (resumedFeeds.incrementAndGet() == 1) {
                        gapRequested.countDown()
                        releaseGap.await(10, TimeUnit.SECONDS)
                        runFeed(
                            runFrame(3, "text_delta", """{"text":"queued old "}""") +
                                runFrame(0, "snapshot", snapshot) +
                                runFrame(1, "text_delta", """{"text":"new prefix "}""") +
                                runFrame(2, "tool_started", """{"toolId":"tool-new","name":"run_command"}""")
                        )
                    } else runFeed("").setHeadersDelay(5, TimeUnit.SECONDS)
                }
                else -> MockResponse().setResponseCode(404)
            }
        }) { model ->
            try {
                withTimeout(5_000) { model.isLoading.first { !it } }
                model.startProgressObservation()
                assertTrue(withContext(Dispatchers.IO) { gapRequested.await(5, TimeUnit.SECONDS) })
                withTimeout(5_000) { model.liveText.first { it == "old prefix " } }

                releaseGap.countDown()
                withTimeout(5_000) { model.tools.first { it.any { tool -> tool.id == "tool-new" } } }
                assertEquals("new prefix ", model.liveText.value)
                assertEquals("", model.reasoning.value)
            } finally {
                releaseGap.countDown()
            }
        }
    }

    @Test
    fun validRunProgressRestoresTheReconnectBudgetAcrossMoreThanFourDisconnects() {
        val wireJson = Json(json) { explicitNulls = false }
        val requests = java.util.concurrent.atomic.AtomicInteger()
        val terminalGate = CountDownLatch(1)
        val terminalRequested = CountDownLatch(1)
        val resumed = java.util.Collections.synchronizedList(mutableListOf<Pair<String?, String?>>())
        val ended = java.util.concurrent.atomic.AtomicBoolean(false)
        val answer = AidenChatMessage("reply-mac", AidenChatRole.ASSISTANT, "abcdef", createdAt = Instant.EPOCH)
        withForeignRunChat(initial = foreignRunChat(), route = { path, request ->
            when (path) {
                "/chats/chat-mac" -> MockResponse().setBody(wireJson.encodeToString(
                    foreignRunChat(if (ended.get()) listOf(answer) else emptyList())
                ))
                "/chats/chat-mac/runs/current/events" -> {
                    requests.incrementAndGet()
                    runFeed(
                        runFrame(1, "run.started", """{"runId":"run-mac","chatId":"chat-mac","origin":"renderer"}""") +
                            runFrame(2, "text_delta", """{"text":"a"}""")
                    )
                }
                "/runs/run-mac/events" -> {
                    resumed.add(request.requestUrl?.queryParameter("after") to request.getHeader("Last-Event-ID"))
                    val attempt = requests.incrementAndGet()
                    if (attempt < 7) runFeed(runFrame(attempt + 1, "text_delta", """{"text":"${"abcdef"[attempt - 1]}"}"""))
                    else {
                        terminalRequested.countDown()
                        terminalGate.await(15, TimeUnit.SECONDS)
                        ended.set(true)
                        runFeed(
                            runFrame(8, "done", """{"messageId":"reply-mac"}""", terminal = true) +
                                runFrame(8, "run.ended", """{"runId":"run-mac","chatId":"chat-mac","state":"done"}""", terminal = true)
                        )
                    }
                }
                else -> MockResponse().setResponseCode(404)
            }
        }) { model ->
            try {
                withTimeout(5_000) { model.isLoading.first { !it } }
                model.startProgressObservation()
                assertTrue(withContext(Dispatchers.IO) { terminalRequested.await(15, TimeUnit.SECONDS) })
                assertTrue("A long healthy run remains controllable", model.canStopCurrentRun)
                assertEquals("abcdef", model.liveText.value)
                assertEquals((2..7).map { it.toString() }, resumed.map { it.first })
                assertEquals((2..7).map { it.toString() }, resumed.map { it.second })
            } finally {
                terminalGate.countDown()
            }
            withTimeout(5_000) { model.chat.first { it?.messages?.any { message -> message.id == "reply-mac" } == true } }
            assertEquals(listOf("reply-mac"), model.chat.value?.messages?.map { it.id })
        }
    }

    @Test
    fun emptyReconnectsAfterALiveRunStillExhaustTheConsecutiveFailureBudget() {
        val wireJson = Json(json) { explicitNulls = false }
        val requests = java.util.concurrent.atomic.AtomicInteger()
        withForeignRunChat(initial = foreignRunChat(), route = { path, _ ->
            when (path) {
                "/chats/chat-mac" -> MockResponse().setBody(wireJson.encodeToString(foreignRunChat()))
                "/chats/chat-mac/runs/current/events" -> {
                    requests.incrementAndGet()
                    runFeed(
                        runFrame(1, "run.started", """{"runId":"run-mac","chatId":"chat-mac","origin":"renderer"}""") +
                            runFrame(2, "text_delta", """{"text":"Still running"}""")
                    )
                }
                "/runs/run-mac/events" -> {
                    requests.incrementAndGet()
                    runFeed("")
                }
                else -> MockResponse().setResponseCode(404)
            }
        }) { model ->
            withTimeout(5_000) { model.isLoading.first { !it } }
            model.startProgressObservation()
            withTimeout(5_000) { model.liveText.first { it == "Still running" } }
            withTimeout(12_000) { model.streamState.first { it == AidenStreamState.INTERRUPTED } }
            assertEquals("The first feed and three retries precede exhaustion", 4, requests.get())
            assertFalse(model.canStopCurrentRun)
        }
    }

    @Test
    fun coldOpenedChatAttachesToTheRunStartedElsewhereOnceTheChatLoads() {
        val wireJson = Json(json) { explicitNulls = false }
        val chatGate = CountDownLatch(1)
        val attaches = java.util.concurrent.LinkedBlockingQueue<String>()
        withForeignRunChat(initial = null, route = { path, _ ->
            when (path) {
                "/chats/chat-mac" -> {
                    chatGate.await(10, TimeUnit.SECONDS)
                    MockResponse().setBody(wireJson.encodeToString(foreignRunChat()))
                }
                "/chats/chat-mac/runs/current/events" -> {
                    attaches.add(path)
                    MockResponse().setResponseCode(404)
                }
                else -> MockResponse().setResponseCode(404)
            }
        }) { model ->
            // Opened from a notification: nothing cached, the chat is still loading.
            model.startProgressObservation()
            assertNull(withContext(Dispatchers.IO) { attaches.poll(300, TimeUnit.MILLISECONDS) })
            chatGate.countDown()
            withTimeout(5_000) { model.chat.first { it != null } }
            assertNotNull(
                "The run started elsewhere must be followed once the chat is known",
                withContext(Dispatchers.IO) { attaches.poll(5, TimeUnit.SECONDS) }
            )
        }
    }

    @Test
    fun runThatKeepsStreamingIsShownLiveWithoutWaitingForAPause() {
        val wireJson = Json(json) { explicitNulls = false }
        val started = runFrame(1, "run.started", """{"runId":"run-mac","chatId":"chat-mac","origin":"renderer"}""")
        val delta = runFrame(2, "text_delta", """{"text":"word "}""")
        val deltas = (2 until 52).joinToString("") { runFrame(it, "text_delta", """{"text":"word "}""") }
        withForeignRunChat(initial = foreignRunChat(), route = { path, _ ->
            when (path) {
                "/chats/chat-mac" -> MockResponse().setBody(wireJson.encodeToString(foreignRunChat()))
                // About one token every 100 ms for five seconds: the feed never goes quiet.
                "/chats/chat-mac/runs/current/events" -> runFeed(started + deltas)
                    .throttleBody(delta.length.toLong(), 100, TimeUnit.MILLISECONDS)
                else -> MockResponse().setResponseCode(404)
            }
        }) { model ->
            withTimeout(5_000) { model.isLoading.first { !it } }
            model.startProgressObservation()
            val shown = withTimeout(2_500) { model.liveText.first { it.isNotEmpty() } }
            assertTrue(shown.startsWith("word "))
            assertTrue("A live foreign run offers Stop", model.canStopCurrentRun)
        }
    }

    @Test
    fun foreignRunResponseStaysVisibleUntilAFailedTranscriptReadRecovers() {
        val wireJson = Json(json) { explicitNulls = false }
        val failReads = java.util.concurrent.atomic.AtomicBoolean(false)
        val runEnded = java.util.concurrent.atomic.AtomicBoolean(false)
        val failedRead = CountDownLatch(1)
        val answer = AidenChatMessage("reply-mac", AidenChatRole.ASSISTANT, "Visible answer", createdAt = Instant.EPOCH)
        withForeignRunChat(initial = foreignRunChat(), route = { path, _ ->
            when (path) {
                "/chats/chat-mac" -> if (failReads.get()) {
                    failedRead.countDown()
                    MockResponse().setResponseCode(500).setBody("""{"code":"internal_error","message":"Try again."}""")
                } else {
                    // The answer is in the transcript only once the run has ended.
                    val messages = if (runEnded.get()) listOf(answer) else emptyList()
                    MockResponse().setBody(wireJson.encodeToString(foreignRunChat(messages)))
                }
                // The attach replay settles and is shown live before the run ends.
                "/chats/chat-mac/runs/current/events" -> runFeed(
                    runFrame(1, "run.started", """{"runId":"run-mac","chatId":"chat-mac","origin":"renderer"}""") +
                        runFrame(2, "text_delta", """{"text":"Visible answer"}""")
                )
                "/runs/run-mac/events" -> {
                    // The transcript read that follows the run's end fails.
                    runEnded.set(true)
                    failReads.set(true)
                    runFeed(
                        runFrame(3, "done", """{"messageId":"reply-mac"}""", terminal = true) +
                            runFrame(3, "run.ended", """{"runId":"run-mac","chatId":"chat-mac","state":"done"}""", terminal = true)
                    )
                }
                else -> MockResponse().setResponseCode(404)
            }
        }) { model ->
            withTimeout(5_000) { model.isLoading.first { !it } }
            model.startProgressObservation()
            withTimeout(5_000) { model.liveText.first { it == "Visible answer" } }
            assertTrue(withContext(Dispatchers.IO) { failedRead.await(10, TimeUnit.SECONDS) })
            withTimeout(5_000) { model.presentedError.first { it != null } }
            assertEquals(AidenStreamState.DONE, model.streamState.value)
            // The transcript that holds the answer was not read: keep showing it.
            assertEquals("Visible answer", model.liveText.value)
            assertTrue(model.chat.value!!.messages.none { it.id == "reply-mac" })
            failReads.set(false)
            // Recovery re-reads the chat on its own; the answer moves into the transcript.
            withTimeout(10_000) { model.chat.first { chat -> chat?.messages?.any { it.id == "reply-mac" } == true } }
            withTimeout(5_000) { model.liveText.first { it.isEmpty() } }
        }
    }

    private fun rosterFrame(turnId: String, revision: Int): String {
        val roster = """{"version":1,"chatId":"chat-mac","turnId":"$turnId","previousTurns":[],"availability":"ready",""" +
            """"epoch":"epoch-run","revision":$revision,"updatedAt":"2026-10-05T10:00:00Z","agents":[]}"""
        return "id: $revision\nevent: agents_update\ndata: {\"protocolVersion\":1,\"streamId\":\"chat-mac\",\"sequence\":$revision," +
            "\"timestamp\":\"2026-10-05T10:00:00Z\",\"type\":\"agents_update\",\"terminal\":false,\"payload\":$roster}\n\n"
    }

    /** A run the Mac started: its opening replay, then a connection that stays open. */
    private fun macRunRoute(path: String): MockResponse? = when (path) {
        "/chats/chat-mac" -> MockResponse().setBody(Json(json) { explicitNulls = false }.encodeToString(foreignRunChat()))
        "/runs/run-mac/events" -> runFeed("").setHeadersDelay(5, TimeUnit.SECONDS)
        else -> null
    }

    private val macRunFeed: MockResponse
        get() = runFeed(
            runFrame(1, "run.started", """{"runId":"run-mac","chatId":"chat-mac","origin":"renderer"}""") +
                runFrame(2, "text_delta", """{"text":"Live from the Mac"}""")
        )

    @Test
    fun rosterAnnouncingANewTurnAttachesToItsRunAndRetriesOnceUntilTheRunIsRegistered() =
        assertRosterTurnAttach(runRegisters = true)

    @Test
    fun rosterTurnWhoseRunNeverAppearsIsLookedUpOnceMoreAndThenLeftAlone() =
        assertRosterTurnAttach(runRegisters = false)

    private fun assertRosterTurnAttach(runRegisters: Boolean) {
        // Lookups and the policy's waits, in the order they happened.
        val log = java.util.Collections.synchronizedList(mutableListOf<String>())
        val rosterRequests = java.util.concurrent.atomic.AtomicInteger(0)
        val macTurnStarted = java.util.concurrent.atomic.AtomicBoolean(false)
        val runRegistered = java.util.concurrent.atomic.AtomicBoolean(false)
        val attach = AidenForeignRunAttachPolicy(pause = { log.add("wait $it") })
        withForeignRunChat(initial = foreignRunChat(), agentsRead = true, attach = attach, route = { path, _ ->
            macRunRoute(path) ?: when (path) {
                "/chats/chat-mac/agents" -> MockResponse().setBody(
                    """{"version":1,"chatId":"chat-mac","turnId":"turn-1","previousTurns":[],"availability":"ready","epoch":"epoch-run","revision":1,"updatedAt":"2026-10-05T10:00:00Z","agents":[]}"""
                )
                "/chats/chat-mac/progress/events" -> {
                    rosterRequests.incrementAndGet()
                    runFeed(if (macTurnStarted.get()) rosterFrame("turn-2", 2) else rosterFrame("turn-1", 1))
                }
                "/chats/chat-mac/runs/current/events" -> {
                    log.add("lookup")
                    if (runRegistered.get()) {
                        macRunFeed
                    } else {
                        // The roster can announce a turn just before its run is registered.
                        if (runRegisters && macTurnStarted.get()) runRegistered.set(true)
                        MockResponse().setResponseCode(404)
                    }
                }
                else -> MockResponse().setResponseCode(404)
            }
        }) { model ->
            withTimeout(5_000) { model.isLoading.first { !it } }
            model.startProgressObservation()
            withTimeout(5_000) { model.agentRoster.first { it?.turnId == "turn-1" } }
            // The lookup made on opening found nothing; the first roster's turn is
            // checked once more, and not again when the feed repeats it.
            withTimeout(5_000) { while (log.size < 2) kotlinx.coroutines.delay(10) }
            awaitRosterReconnects(rosterRequests, 2)
            assertEquals(listOf("lookup", "lookup"), log.toList())

            macTurnStarted.set(true)
            withTimeout(5_000) { model.agentRoster.first { it?.turnId == "turn-2" } }
            if (runRegisters) {
                withTimeout(5_000) { model.liveText.first { it == "Live from the Mac" } }
                assertTrue("A live foreign run offers Stop", model.canStopCurrentRun)
            } else {
                withTimeout(5_000) { while (log.count { it == "lookup" } < 4) kotlinx.coroutines.delay(10) }
                awaitRosterReconnects(rosterRequests, 2)
                assertEquals("", model.liveText.value)
            }
            assertEquals(
                "Opening, the first roster, the announced turn, then one retry after waiting for the run to register",
                listOf("lookup", "lookup", "lookup", "wait 400", "lookup"),
                log.toList()
            )
        }
    }

    /** Waits until the roster feed has been reopened [count] more times, so each earlier frame was handled. */
    private suspend fun awaitRosterReconnects(requests: java.util.concurrent.atomic.AtomicInteger, count: Int) {
        val target = requests.get() + count
        withTimeout(5_000) { while (requests.get() < target) kotlinx.coroutines.delay(10) }
    }

    @Test
    fun rosterAnnouncingThisPhonesOwnFinishedTurnDoesNotLookForARun() {
        val wireJson = Json(json) { explicitNulls = false }
        val lookups = java.util.concurrent.atomic.AtomicInteger(0)
        val rosterRequests = java.util.concurrent.atomic.AtomicInteger(0)
        val announceOwnTurn = java.util.concurrent.atomic.AtomicBoolean(false)
        val question = AidenChatMessage(
            id = "question-1", role = AidenChatRole.USER, text = "Compare plans", createdAt = Instant.EPOCH
        )
        withForeignRunChat(initial = foreignRunChat(), agentsRead = true, route = { path, _ ->
            when (path) {
                "/chats/chat-mac" -> MockResponse().setBody(wireJson.encodeToString(foreignRunChat()))
                "/chats/chat-mac/turns" -> MockResponse().setResponseCode(202).setBody(
                    """{"turnId":"turn-phone","streamId":"stream-phone","status":"queued","message":${wireJson.encodeToString(question)}}"""
                )
                "/streams/stream-phone/events" -> runFeed(
                    "id: 1\nevent: done\ndata: {\"protocolVersion\":1,\"streamId\":\"stream-phone\",\"sequence\":1," +
                        "\"timestamp\":\"2026-10-05T10:00:00Z\",\"type\":\"done\",\"terminal\":true,\"payload\":{\"messageId\":\"reply-1\"}}\n\n"
                )
                "/streams/stream-phone" -> MockResponse().setBody(
                    """{"streamId":"stream-phone","chatId":"chat-mac","turnId":"turn-phone","state":"done","lastSequence":1,"updatedAt":"2026-10-05T10:00:00Z"}"""
                )
                "/chats/chat-mac/agents" -> MockResponse().setBody(
                    """{"version":1,"chatId":"chat-mac","turnId":"turn-1","previousTurns":[],"availability":"ready","epoch":"epoch-run","revision":1,"updatedAt":"2026-10-05T10:00:00Z","agents":[]}"""
                )
                "/chats/chat-mac/progress/events" -> {
                    rosterRequests.incrementAndGet()
                    runFeed(if (announceOwnTurn.get()) rosterFrame("turn-phone", 2) else rosterFrame("turn-1", 1))
                }
                "/chats/chat-mac/runs/current/events" -> {
                    lookups.incrementAndGet()
                    MockResponse().setResponseCode(404)
                }
                else -> MockResponse().setResponseCode(404)
            }
        }) { model ->
            withTimeout(5_000) { model.isLoading.first { !it } }
            model.startProgressObservation()
            withTimeout(5_000) { model.agentRoster.first { it?.turnId == "turn-1" } }
            withTimeout(5_000) { while (lookups.get() < 2) kotlinx.coroutines.delay(10) }

            model.updateDraft("Compare plans")
            model.send()
            withTimeout(5_000) { model.isStarting.first { it } }
            withTimeout(5_000) {
                while (model.isStarting.value || model.hasActiveStream.value) kotlinx.coroutines.delay(10)
            }
            // The roster reports the phone's own turn only after its stream has ended.
            announceOwnTurn.set(true)
            withTimeout(5_000) { model.agentRoster.first { it?.turnId == "turn-phone" } }
            awaitRosterReconnects(rosterRequests, 2)
            assertEquals("Only the lookups made on opening and for the first roster", 2, lookups.get())
        }
    }

    @Test
    fun withoutRosterAccessAnOpenChatProbesForARunWithBackoffAndStopsInTheBackground() {
        // Lookups and the policy's waits, in the order they happened. Each wait
        // holds until the test releases it, standing in for the clock.
        val log = java.util.Collections.synchronizedList(mutableListOf<String>())
        val release = kotlinx.coroutines.channels.Channel<Unit>(kotlinx.coroutines.channels.Channel.UNLIMITED)
        val registerAfterLookup = java.util.concurrent.atomic.AtomicInteger(Int.MAX_VALUE)
        val attach = AidenForeignRunAttachPolicy(
            probeDelaysMillis = listOf(5_000L, 10_000L, 20_000L),
            pause = { log.add("wait $it"); release.receive() }
        )
        fun lookups() = log.count { it == "lookup" }
        suspend fun awaitLog(size: Int) = withTimeout(5_000) { while (log.size < size) kotlinx.coroutines.delay(10) }
        withForeignRunChat(initial = foreignRunChat(), attach = attach, route = { path, _ ->
            macRunRoute(path) ?: when (path) {
                "/chats/chat-mac/runs/current/events" -> {
                    log.add("lookup")
                    if (lookups() > registerAfterLookup.get()) macRunFeed else MockResponse().setResponseCode(404)
                }
                else -> MockResponse().setResponseCode(404)
            }
        }) { model ->
            withTimeout(5_000) { model.isLoading.first { !it } }
            model.startProgressObservation()
            // The first wait starts only once the lookup made on opening has answered.
            awaitLog(2)
            assertEquals(listOf("lookup", "wait 5000"), log.toList())
            // Each probe answers before the next, longer wait; the last wait repeats.
            repeat(3) { release.send(Unit) }
            awaitLog(8)
            assertEquals(
                listOf("lookup", "wait 5000", "lookup", "wait 10000", "lookup", "wait 20000", "lookup", "wait 20000"),
                log.toList()
            )

            // In the background the pending probe is dropped.
            model.stopProgressObservation()
            val backgrounded = log.size
            kotlinx.coroutines.delay(200)
            assertEquals(backgrounded, log.size)

            // Back on screen the probe starts over and finds a run the Mac
            // started after the lookup made on reopening.
            registerAfterLookup.set(lookups() + 1)
            model.startProgressObservation()
            awaitLog(backgrounded + 2)
            assertEquals(listOf("lookup", "wait 5000"), log.drop(backgrounded))
            release.send(Unit)
            withTimeout(5_000) { model.liveText.first { it == "Live from the Mac" } }
            assertEquals(listOf("lookup", "wait 5000", "lookup"), log.drop(backgrounded))
        }
    }

    @Test
    fun aTitleRefreshHoldingAForeignRunsReplyRetiresItsCardWhileRecoveryRetries() {
        val wireJson = Json(json) { explicitNulls = false }
        val runEnded = java.util.concurrent.atomic.AtomicBoolean(false)
        val failedRead = CountDownLatch(1)
        val answer = AidenChatMessage("reply-mac", AidenChatRole.ASSISTANT, "Visible answer", createdAt = Instant.EPOCH)
        // The title is settled with the run, so the title refresh keeps reading until the run has ended.
        fun chat() = if (runEnded.get()) foreignRunChat(listOf(answer)) else foreignRunChat().apply { titlePending = true }
        withForeignRunChat(initial = chat(), features = listOf(
            "phone-run-control-v1", AidenRemoteProtocol.CHAT_MESSAGES_WINDOW_FEATURE,
            AidenRemoteProtocol.CHAT_MESSAGES_WINDOW_METADATA_FEATURE
        ), route = { path, _ ->
            when (path) {
                // Transcript reads, including the recovery after the run ends, page the
                // latest messages; every one of them fails once the run is over.
                "/chats/chat-mac/messages" -> if (runEnded.get()) {
                    failedRead.countDown()
                    MockResponse().setResponseCode(500).setBody("""{"code":"internal_error","message":"Try again."}""")
                } else chat().let {
                    MockResponse().setBody(wireJson.encodeToString(AidenChatMessagesWindow(
                        it.id, it.revision, it.messages, hasOlder = false, workspaceId = it.workspaceId, title = it.title,
                        titlePending = it.titlePending, createdAt = it.createdAt, updatedAt = it.updatedAt
                    )))
                }
                // Only the title refresh reads the whole chat.
                "/chats/chat-mac" -> MockResponse().setBody(wireJson.encodeToString(chat()))
                "/chats/chat-mac/runs/current/events" -> runFeed(
                    runFrame(1, "run.started", """{"runId":"run-mac","chatId":"chat-mac","origin":"renderer"}""") +
                        runFrame(2, "text_delta", """{"text":"Visible answer"}""")
                )
                "/runs/run-mac/events" -> {
                    runEnded.set(true)
                    runFeed(
                        runFrame(3, "done", """{"messageId":"reply-mac"}""", terminal = true) +
                            runFrame(3, "run.ended", """{"runId":"run-mac","chatId":"chat-mac","state":"done"}""", terminal = true)
                    )
                }
                else -> MockResponse().setResponseCode(404)
            }
        }) { model ->
            withTimeout(5_000) { model.isLoading.first { !it } }
            model.startProgressObservation()
            withTimeout(5_000) { model.liveText.first { it == "Visible answer" } }
            assertTrue(withContext(Dispatchers.IO) { failedRead.await(10, TimeUnit.SECONDS) })
            withTimeout(10_000) { model.chat.first { chat -> chat?.messages?.any { it.id == "reply-mac" } == true } }
            // The reply is in the transcript now, so its finished live card goes, though
            // the recovery that was keeping it on screen never gets a page.
            withTimeout(2_000) { model.liveText.first { it.isEmpty() } }
            assertFalse(AidenChatScroll.showsLiveCard(model.streamState.value, model.liveText.value.isNotEmpty()))
            // The failed read's banner goes with it, since the reply it was recovering is shown.
            assertNull(model.presentedError.value)
        }
    }

    @Test
    fun viewModelCleanupWaitsForSuspendedFinalizerBeforeReleasingMain() = exerciseViewModelCleanup(false)

    @Test
    fun cancelledCallerCleanupWaitsForSuspendedFinalizerBeforeReleasingMain() = exerciseViewModelCleanup(true)

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private fun exerciseViewModelCleanup(cancelCaller: Boolean) {
        val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val owners = ViewModelStore()
        val release = CompletableDeferred<Unit>()
        Dispatchers.setMain(dispatcher)
        try {
            runBlocking(dispatcher) {
                val model = object : ViewModel() {}
                owners.put("held-finalizer", model)
                val entered = CompletableDeferred<Unit>()
                var finalizedOnMain = false
                val mainThread = Thread.currentThread()
                val child = model.viewModelScope.launch(start = CoroutineStart.UNDISPATCHED) {
                    try {
                        awaitCancellation()
                    } finally {
                        withContext(NonCancellable) {
                            entered.complete(Unit)
                            withContext(Dispatchers.IO) { release.await() }
                            assertSame(mainThread, Thread.currentThread())
                            finalizedOnMain = true
                        }
                    }
                }
                var resourcesReleased = false
                val cleanup = launch(start = CoroutineStart.UNDISPATCHED) {
                    try {
                        if (cancelCaller) awaitCancellation()
                    } finally {
                        owners.clearAndJoin()
                        resourcesReleased = true
                    }
                }
                if (cancelCaller) cleanup.cancel()
                try {
                    withTimeout(5_000) { entered.await() }
                    assertFalse("Cleanup must wait while a cancelled child still needs Main", cleanup.isCompleted)
                    assertFalse(finalizedOnMain)
                    assertFalse(resourcesReleased)
                } finally {
                    release.complete(Unit)
                    child.join()
                    cleanup.join()
                }
                assertTrue(finalizedOnMain)
                assertTrue("Cleanup must finish releasing resources even when its caller was cancelled", resourcesReleased)
                assertTrue(model.viewModelScope.coroutineContext[Job]!!.isCompleted)
            }
        } finally {
            release.complete(Unit)
            runBlocking(dispatcher) { owners.clearAndJoin() }
            Dispatchers.resetMain()
            dispatcher.close()
        }
    }

    @Test fun readAloudEligibilityRejectsProjectedFailuresAndCancellation() {
        val message = AidenChatMessage("a", AidenChatRole.ASSISTANT, "partial answer", createdAt = Instant.now())
        assertTrue(message.isReadAloudEligible)
        for (status in AidenMessageOutcomeStatus.entries) {
            assertFalse(message.copy(outcome = AidenMessageOutcome(status)).isReadAloudEligible)
        }
        assertFalse(message.copy(role = AidenChatRole.USER).isReadAloudEligible)
    }
    @Test fun readAloudProgressWatchdogAllowsLongJobsButBoundsStalls() {
        var stalled = 0
        for (poll in 1..3_000) {
            stalled = AidenReadAloudJob.nextStalledPollCount((poll - 1) / 100, poll / 100, stalled)
            assertTrue(stalled < AidenReadAloudJob.MAXIMUM_STALLED_POLLS)
        }
        repeat(AidenReadAloudJob.MAXIMUM_STALLED_POLLS) { stalled = AidenReadAloudJob.nextStalledPollCount(30, 30, stalled) }
        assertEquals(AidenReadAloudJob.MAXIMUM_STALLED_POLLS, stalled)
    }
    @Test fun unpricedSpeechDoesNotDisplayFreeHostedCost() {
        val totals = AidenUsageTotals(requests = 2, completedRequests = 1, failedRequests = 1, cancelledRequests = 0,
            reportedTokenRequests = 1, unmeteredRequests = 1, localRequests = 0, costedRequests = 0,
            unpricedHostedRequests = 1, hostedCostUsd = 0.0, activeDays = 1, currentStreak = 1, longestStreak = 1,
            tokens = AidenUsageTokens(0, 0, 0, 0, 0, 0, 0))
        assertEquals("Cost unavailable", totals.copy(unpricedHostedRequests = 1, costedRequests = 0, hostedCostUsd = 0.0).hostedCostSummary)
        assertTrue(totals.copy(unpricedHostedRequests = 1, costedRequests = 1, hostedCostUsd = 0.2).hostedCostSummary.contains("1 requests unpriced"))
    }

    @Test fun readAloudUsesSharedFixtureAndRejectsInvalidAudio() {
        val data = javaClass.classLoader!!.getResourceAsStream("contract.json")!!.bufferedReader().use { it.readText() }
        val root = Json.parseToJsonElement(data) as kotlinx.serialization.json.JsonObject
        val decoder = Json { ignoreUnknownKeys = true }
        val status = decoder.decodeFromString<sbtbiswas.AidenOnTheGo.models.AidenReadAloudStatus>(root.getValue("readAloudStatus").toString())
        val audio = decoder.decodeFromString<sbtbiswas.AidenOnTheGo.models.AidenReadAloudAudio>(root.getValue("readAloudAudio").toString())
        assertTrue(status.enabled && status.ready)
        assertEquals("chat-1", status.source?.chatId)
        assertTrue(audio.validatedBytes(0, null).contentEquals(byteArrayOf(1, 2)))
        for (bad in listOf(audio.copy(complete = false), audio.copy(nextOffset = 1), audio.copy(segmentBytes = 9 * 1024 * 1024), audio.copy(channels = 2))) {
            assertTrue(runCatching { bad.validatedBytes(0, null) }.isFailure)
        }
        assertTrue(runCatching { audio.validatedBytes(1, null) }.isFailure)
        assertFalse(sbtbiswas.AidenOnTheGo.models.AidenReadAloudJob("job", "chat", "unknown", 1, 1).isValid)
        assertTrue(sbtbiswas.AidenOnTheGo.models.READ_ALOUD_SETUP_GUIDANCE.contains("desktop"))
    }

    @Test fun producedFileProvenanceRejectsForeignPathsAndUnrelatedTools() {
        val file = sbtbiswas.AidenOnTheGo.models.AidenProducedFile("out/report.txt", "written", 12)
        assertTrue(file.isValid("write_file"))
        assertTrue(file.copy(relativePath = "foo:bar.txt").isValid("write_file"))
        assertTrue(file.copy(relativePath = "😀".repeat(121)).isValid("write_file"))
        assertFalse(file.copy(relativePath = "😀".repeat(241)).isValid("write_file"))
        assertFalse(file.isValid("mcp_write"))
        assertFalse(file.isValid("edit_file"))
        for (path in listOf("C:/private", "/Users/private", "../secret", "a/../b", "a//b", "a\\b", "bad\nname")) {
            assertFalse(file.copy(relativePath = path).isValid("write_file"))
        }
        assertEquals(file, Json.decodeFromString<sbtbiswas.AidenOnTheGo.models.AidenProducedFile>(Json.encodeToString(file)))
    }

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    // Mac wire shape: absent optionals are omitted, never sent as null. A regular chat that
    // carries `botId: null` beside `reasoning` is refused by the private-field validator.
    private val wireJson = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }

    @Test
    fun chronologicalReasoningKeepsToolsAndProseInOrder() {
        val timeline = AidenGenerationTimeline(
            version = 3, generationId = "stream-1", status = AidenGenerationTimelineStatus.COMPLETED,
            startedAt = 1000.0, finishedAt = 2000.0,
            steps = listOf(
                AidenAgentStep("think-1", 0, AidenAgentStep.Kind.THINKING,
                    startedAt = 1000.0, updatedAt = 1100.0, finishedAt = 1100.0,
                    contentOffset = 0, reasoningStartOffset = 0, reasoningEndOffset = 5),
                AidenAgentStep("tool-1", 1, AidenAgentStep.Kind.TOOL,
                    toolCallId = "call-1", toolName = "read_file", label = "Read file",
                    status = AidenAgentStepStatus.COMPLETED, startedAt = 1100.0,
                    updatedAt = 1200.0, finishedAt = 1200.0, contentOffset = 0),
                AidenAgentStep("think-2", 2, AidenAgentStep.Kind.THINKING,
                    startedAt = 1200.0, updatedAt = 1300.0, finishedAt = 1300.0,
                    contentOffset = 7, reasoningStartOffset = 7, reasoningEndOffset = 13)
            )
        )
        val message = AidenChatMessage("message-1", AidenChatRole.ASSISTANT,
            "Before.After.", reasoning = "First\n\nSecond", timeline = timeline, createdAt = Instant.EPOCH)
        assertTrue(message.isWireSafe)
        assertEquals(
            listOf("REASONING:First", "TOOL:", "TEXT:Before.", "REASONING:Second", "TEXT:After."),
            AidenChronologicalProjection.rows(message.text, message.reasoning.orEmpty(), message.timeline)
                ?.map { "${it.kind}:${it.text}" }
        )
        assertNull(AidenChronologicalProjection.rows(message.text, "First", timeline))
        val hiddenTimeline = timeline.copy(steps = timeline.steps.map { step ->
            step.copy(reasoningStartOffset = null, reasoningEndOffset = null)
        })
        assertEquals(
            listOf(AidenChronologicalRow.Kind.REASONING, AidenChronologicalRow.Kind.TOOL,
                AidenChronologicalRow.Kind.TEXT, AidenChronologicalRow.Kind.REASONING,
                AidenChronologicalRow.Kind.TEXT),
            AidenChronologicalProjection.rows(message.text, "", hiddenTimeline)?.map { it.kind }
        )
    }

    private val answeredQuestionnaireJson = """{"version":1,"outcome":"answered","items":[""" +
        """{"question":"Which database?","header":"Database","kind":"option","answers":["Postgres"]},""" +
        """{"question":"Which extras?","header":"Extras","kind":"multi","answers":["Auth","Billing"]},""" +
        """{"question":"Anything else?","header":"Notes","kind":"custom","answers":["Keep it small"]},""" +
        """{"question":"Deploy target?","header":"Deploy","kind":"skipped","answers":[]}]}"""

    private fun questionnaireTimelineJson(
        questionnaire: String = answeredQuestionnaireJson,
        toolName: String = "ask_user_question",
        status: String = "completed"
    ) = """{"version":3,"generationId":"generation-questions","status":"completed","startedAt":1000,"finishedAt":2000,"steps":[""" +
        """{"id":"tool-1","order":0,"kind":"tool","toolCallId":"call-1","toolName":"read_file","label":"Read file","status":"completed","startedAt":1000,"updatedAt":1100,"finishedAt":1100,"contentOffset":7},""" +
        """{"id":"tool-2","order":1,"kind":"tool","toolCallId":"call-2","toolName":"$toolName","label":"Ask","status":"$status","startedAt":1100,"updatedAt":1500,"finishedAt":1500,"contentOffset":7,"questionnaire":$questionnaire},""" +
        """{"id":"tool-3","order":2,"kind":"tool","toolCallId":"call-3","toolName":"run_command","label":"Run command","status":"completed","startedAt":1500,"updatedAt":1600,"finishedAt":1600,"contentOffset":7}]}"""

    @Test
    fun answeredQuestionnaireBecomesItsOwnRowAtItsPositionAndLeavesTheActivityTally() {
        val timeline = wireJson.decodeFromString<AidenGenerationTimeline>(questionnaireTimelineJson())
        val message = AidenChatMessage("message-q", AidenChatRole.ASSISTANT, "Before.After.",
            timeline = timeline, createdAt = Instant.EPOCH)
        assertTrue(message.isWireSafe)

        val recap = timeline.steps[1].questionnaireRecap
        assertNotNull(recap)
        assertEquals(AidenQuestionnaireRecap.Outcome.ANSWERED, recap!!.outcome)
        assertEquals(listOf("Which database?", "Which extras?", "Anything else?", "Deploy target?"),
            recap.items.map { it.question })

        // The recap splits the activity at its offset: the read before it and the
        // command after it stay activity lines on either side of the answers.
        val rows = AidenChronologicalProjection.rows(message.text, "", timeline)!!
        assertEquals(
            listOf("TEXT:Before.", "TOOL:tool-1", "QUESTIONNAIRE:tool-2", "TOOL:tool-3", "TEXT:After."),
            rows.map { row -> "${row.kind}:${row.text.ifEmpty { row.steps.joinToString(",") { it.id } }}" }
        )
        assertEquals(recap, rows[2].questionnaire)

        // Two tool calls are activity; the questionnaire is not counted.
        assertEquals("Explored 1 file, ran 1 command", AidenAgentActivityPresentation.summary(timeline))
        assertEquals(listOf("tool-1", "tool-3"),
            AidenAgentActivityPresentation.activityTimeline(timeline).steps.map { it.id })

        // The chat cache re-encodes the step; the recap survives the round trip.
        val cached = json.decodeFromString<AidenGenerationTimeline>(json.encodeToString(timeline))
        assertEquals(recap, cached.steps[1].questionnaireRecap)
        // An absent recap stays absent on the wire rather than turning into null.
        assertFalse(wireJson.encodeToString(timeline.steps[0]).contains("questionnaire"))
    }

    @Test
    fun liveFallbackListsTheTimelineCallsAndRecapsInsteadOfTheStreamToolRows() {
        val timeline = wireJson.decodeFromString<AidenGenerationTimeline>(questionnaireTimelineJson())
        // The stream's text has not reached the steps' offset yet, so the reply has no
        // chronological rows and falls back to listing activity.
        assertNull(AidenChronologicalProjection.rows("Bef", "", timeline))
        // Live rows carry stream ids that match no step's toolCallId.
        val liveTools = listOf(
            AidenLiveTool("tool_1", "read_file", "completed"),
            AidenLiveTool("tool_2", "ask_user_question", "completed"),
            AidenLiveTool("tool_3", "run_command")
        )

        assertEquals(listOf("tool-1", "tool-3"),
            AidenAgentActivityPresentation.liveToolSteps(timeline).map { it.id })
        assertEquals(listOf("Which database?", "Which extras?", "Anything else?", "Deploy target?"),
            AidenAgentActivityPresentation.questionnaireSteps(timeline).single().questionnaireRecap!!.items.map { it.question })
        assertFalse(AidenAgentActivityPresentation.showsLiveToolRows(liveTools, timeline))

        // A recap alone still covers its call: the plain question row stays hidden.
        val recapOnly = timeline.copy(steps = listOf(timeline.steps[1]))
        assertTrue(AidenAgentActivityPresentation.liveToolSteps(recapOnly).isEmpty())
        assertFalse(AidenAgentActivityPresentation.showsLiveToolRows(liveTools, recapOnly))

        // Before the timeline knows any call, the stream's rows are all there is.
        assertTrue(AidenAgentActivityPresentation.showsLiveToolRows(liveTools, null))
        assertTrue(AidenAgentActivityPresentation.showsLiveToolRows(liveTools, timeline.copy(steps = emptyList())))
        assertFalse(AidenAgentActivityPresentation.showsLiveToolRows(emptyList(), null))
        assertTrue(AidenAgentActivityPresentation.questionnaireSteps(null).isEmpty())
    }

    @Test
    fun questionnaireAnswersReadAsChoicesQuotesOrTheReasonTheyWereUnanswered() {
        val recap = AidenQuestionnaireRecap.fromJson(Json.parseToJsonElement(answeredQuestionnaireJson))!!
        assertEquals(
            listOf(
                AidenQuestionnaireRecap.Answer.Choice("Postgres"),
                AidenQuestionnaireRecap.Answer.Choice("Auth, Billing"),
                AidenQuestionnaireRecap.Answer.Custom("Keep it small"),
                AidenQuestionnaireRecap.Answer.Unanswered(AidenQuestionnaireRecap.Outcome.ANSWERED)
            ),
            recap.items.map(recap::answer)
        )
        for (outcome in listOf("dismissed", "expired")) {
            val closed = AidenQuestionnaireRecap.fromJson(Json.parseToJsonElement(
                """{"version":1,"outcome":"$outcome","items":[{"question":"Which database?","header":"Database","kind":"skipped","answers":[]}]}"""
            ))!!
            assertEquals(outcome, closed.outcome.wire)
            assertTrue(closed.answer(closed.items.single()) is AidenQuestionnaireRecap.Answer.Unanswered)
        }
    }

    @Test
    fun malformedQuestionnaireIsDroppedWhileTheStepAndChatStillRender() {
        fun item(kind: String, answers: String, question: String = "Which database?", header: String = "Database") =
            """{"question":"$question","header":"$header","kind":"$kind","answers":$answers}"""
        fun recap(outcome: String = "answered", version: String = "1", vararg items: String) =
            """{"version":$version,"outcome":"$outcome","items":[${items.joinToString(",")}]}"""
        val oneItem = item("option", """["Postgres"]""")
        val malformed = mapOf(
            "option with two answers" to recap(items = arrayOf(item("option", """["Postgres","MySQL"]"""))),
            "option with no answer" to recap(items = arrayOf(item("option", "[]"))),
            "multi with a repeated label" to recap(items = arrayOf(item("multi", """["Auth","Auth"]"""))),
            "multi with six labels" to recap(items = arrayOf(item("multi", """["a","b","c","d","e","f"]"""))),
            "custom with two answers" to recap(items = arrayOf(item("custom", """["a","b"]"""))),
            "skipped with an answer" to recap(items = arrayOf(item("skipped", """["Postgres"]"""))),
            "answer on a dismissed card" to recap(outcome = "dismissed", items = arrayOf(oneItem)),
            "answer on an expired card" to recap(outcome = "expired", items = arrayOf(oneItem)),
            "no items" to recap(),
            "five items" to recap(items = Array(5) { oneItem }),
            "unknown kind" to recap(items = arrayOf(item("ranking", """["Postgres"]"""))),
            "unknown outcome" to recap(outcome = "ignored", items = arrayOf(oneItem)),
            "future version" to recap(version = "2", items = arrayOf(oneItem)),
            "string version" to recap(version = "\"1\"", items = arrayOf(oneItem)),
            "non-string answer" to recap(items = arrayOf(item("option", "[7]"))),
            "answers not a list" to recap(items = arrayOf(item("option", "\"Postgres\""))),
            "blank question" to recap(items = arrayOf(item("option", """["Postgres"]""", question = "  "))),
            "header over 16 characters" to recap(items = arrayOf(item("option", """["Postgres"]""", header = "A".repeat(17)))),
            "control character" to recap(items = arrayOf(item("option", """["Post\u0007gres"]"""))),
            "label over 60 characters" to recap(items = arrayOf(item("option", """["${"x".repeat(61)}"]"""))),
            "not an object" to "\"answered\"",
            "null" to "null"
        )
        for ((case, questionnaire) in malformed) {
            val timeline = wireJson.decodeFromString<AidenGenerationTimeline>(questionnaireTimelineJson(questionnaire))
            val step = timeline.steps[1]
            assertNull(case, step.questionnaire)
            assertEquals(case, "ask_user_question", step.toolName)
            assertTrue(case, timeline.isRendererSafe(contentLength = 13))
            // Without a recap the questionnaire is an ordinary activity line again.
            val rows = AidenChronologicalProjection.rows("Before.After.", "", timeline)!!
            assertEquals(case, listOf("tool-1", "tool-2", "tool-3"),
                rows.single { it.kind == AidenChronologicalRow.Kind.TOOL }.steps.map { it.id })
        }

        // A literal tab or newline is allowed inside a custom answer.
        val multiline = wireJson.decodeFromString<AidenGenerationTimeline>(questionnaireTimelineJson(
            recap(items = arrayOf(item("custom", """["Line one\nLine two"]"""))))
        )
        assertEquals("Line one\nLine two", multiline.steps[1].questionnaireRecap?.items?.single()?.answers?.single())
    }

    @Test
    fun recapOutsideACompletedAskUserQuestionStepKeepsTheActivityLine() {
        for ((toolName, status) in listOf("ask_user_question" to "cancelled", "read_file" to "completed")) {
            val timeline = wireJson.decodeFromString<AidenGenerationTimeline>(
                questionnaireTimelineJson(toolName = toolName, status = status)
            )
            assertNull(timeline.steps[1].questionnaireRecap)
            val rows = AidenChronologicalProjection.rows("Before.After.", "", timeline)!!
            assertTrue(rows.none { it.kind == AidenChronologicalRow.Kind.QUESTIONNAIRE })
            assertEquals(listOf("tool-1", "tool-2", "tool-3"),
                rows.single { it.kind == AidenChronologicalRow.Kind.TOOL }.steps.map { it.id })
            assertEquals(3, AidenAgentActivityPresentation.activityTimeline(timeline).steps.size)
        }
    }

    private val extractedPriceJson =
        """{"name":"pro_monthly","status":"extracted","value":"20","confidence":0.97,"sourceLine":"Pro is ${'$'}20 per month."}"""

    private fun extractRecapJson(vararg fields: String, extra: String = "") =
        """{"version":1,"host":"acme.example","cut":false$extra,"fields":[${fields.joinToString(",")}]}"""

    private fun extractTimelineJson(
        extraction: String = extractRecapJson(extractedPriceJson),
        toolName: String = "web_fetch",
        status: String = "completed"
    ) = """{"version":3,"generationId":"generation-pages","status":"completed","startedAt":1000,"finishedAt":2000,"steps":[""" +
        """{"id":"tool-1","order":0,"kind":"tool","toolCallId":"call-1","toolName":"web_search","label":"Search the web","status":"completed","startedAt":1000,"updatedAt":1100,"finishedAt":1100,"contentOffset":7},""" +
        """{"id":"tool-2","order":1,"kind":"tool","toolCallId":"call-2","toolName":"$toolName","label":"Fetch web page","status":"$status","startedAt":1100,"updatedAt":1500,"finishedAt":1500,"contentOffset":7,"detail":"acme.example","extraction":$extraction},""" +
        """{"id":"tool-3","order":2,"kind":"tool","toolCallId":"call-3","toolName":"read_file","label":"Read file","status":"completed","startedAt":1500,"updatedAt":1600,"finishedAt":1600,"contentOffset":7}]}"""

    @Test
    fun extractedValuesFollowTheLineThatReadThemAndThePageStaysInTheTally() {
        val timeline = wireJson.decodeFromString<AidenGenerationTimeline>(extractTimelineJson(extractRecapJson(
            extractedPriceJson,
            """{"name":"team_yearly","status":"uncertain","value":"1399","confidence":0.92,"notFound":true}""",
            """{"name":"seats","status":"uncertain","value":"50","confidence":0.4,"sourceLine":"Up to 50 seats."}""",
            """{"name":"enterprise","status":"null"}"""
        )))
        val recap = timeline.steps[1].extractionRecap
        assertNotNull(recap)
        assertEquals(
            listOf(
                AidenWebExtractRecap.Status.EXTRACTED, AidenWebExtractRecap.Status.UNCERTAIN,
                AidenWebExtractRecap.Status.UNCERTAIN, AidenWebExtractRecap.Status.ABSENT
            ),
            recap!!.fields.map { it.status }
        )
        assertEquals(listOf("pro monthly", "team yearly", "seats", "enterprise"), recap.fields.map { it.label })
        assertEquals("Pro is $20 per month.", recap.fields[0].sourceLine)
        assertEquals(true, recap.fields[1].notFound)
        assertNull(recap.fields[3].value)

        val rows = AidenChronologicalProjection.rows("Before.After.", "", timeline)!!
        assertEquals(
            listOf("TEXT:Before.", "TOOL:tool-1,tool-2,tool-3", "EXTRACTION:tool-2", "TEXT:After."),
            rows.map { row -> "${row.kind}:${row.text.ifEmpty { row.steps.joinToString(",") { it.id } }}" }
        )
        assertEquals(recap, rows[2].extraction)
        assertEquals(rows.size, rows.map { it.id }.toSet().size)

        // The page read stays an activity line and counts in the tally.
        assertEquals("Explored 1 file, 1 web search, 1 web page", AidenAgentActivityPresentation.summary(timeline))
        assertEquals("Fetched web page acme.example", AidenAgentActivityPresentation.line(timeline.steps[1]))
        assertEquals(3, AidenAgentActivityPresentation.activityTimeline(timeline).steps.size)
        assertEquals(listOf("tool-2"), AidenAgentActivityPresentation.extractionSteps(timeline).map { it.id })

        // The chat cache re-encodes the step; the recap survives the round trip.
        val cached = json.decodeFromString<AidenGenerationTimeline>(json.encodeToString(timeline))
        assertEquals(recap, cached.steps[1].extractionRecap)
        assertFalse(wireJson.encodeToString(timeline.steps[0]).contains("extraction"))

        // A failed extraction carries its reason and no fields.
        val failed = wireJson.decodeFromString<AidenGenerationTimeline>(
            extractTimelineJson(extractRecapJson(extra = ""","error":"quota""""))
        ).steps[1].extractionRecap
        assertEquals(AidenWebExtractRecap.Failure.QUOTA, failed?.error)
        assertTrue(failed!!.fields.isEmpty())
    }

    @Test
    fun malformedOrMisplacedExtractRecapIsDroppedButThePageStaysAnActivityLine() {
        val malformed = listOf(
            "no fields and no error" to extractRecapJson(),
            "an error with fields" to extractRecapJson(extractedPriceJson, extra = ""","error":"quota""""),
            "unknown error" to extractRecapJson(extra = ""","error":"teapot""""),
            "seventeen fields" to extractRecapJson(*Array(17) { """{"name":"f$it","status":"null"}""" }),
            "duplicate names" to extractRecapJson(extractedPriceJson, extractedPriceJson),
            "extracted without its page line" to extractRecapJson("""{"name":"pro","status":"extracted","value":"20","confidence":0.9}"""),
            "extracted marked not found" to extractRecapJson("""{"name":"pro","status":"extracted","value":"20","confidence":0.9,"sourceLine":"Pro is 20.","notFound":true}"""),
            "absent with a value" to extractRecapJson("""{"name":"pro","status":"null","value":"20"}"""),
            "notFound false" to extractRecapJson("""{"name":"pro","status":"uncertain","notFound":false}"""),
            "confidence above one" to extractRecapJson("""{"name":"pro","status":"uncertain","confidence":1.2}"""),
            "string confidence" to extractRecapJson("""{"name":"pro","status":"uncertain","confidence":"0.9"}"""),
            "field name with a space" to extractRecapJson("""{"name":"pro monthly","status":"null"}"""),
            "field name starting with a digit" to extractRecapJson("""{"name":"1price","status":"null"}"""),
            "newline in a source line" to extractRecapJson("""{"name":"pro","status":"uncertain","sourceLine":"Pro is\n20"}"""),
            "double space in a value" to extractRecapJson("""{"name":"pro","status":"uncertain","value":"20  USD"}"""),
            "no-break space in a value" to extractRecapJson("""{"name":"pro","status":"uncertain","value":"20 USD"}"""),
            "value over 200 characters" to extractRecapJson("""{"name":"pro","status":"uncertain","value":"${"9".repeat(201)}"}"""),
            "null value" to extractRecapJson("""{"name":"pro","status":"uncertain","value":null}"""),
            "unknown status" to extractRecapJson("""{"name":"pro","status":"maybe"}"""),
            "future version" to """{"version":2,"host":"acme.example","cut":false,"fields":[$extractedPriceJson]}""",
            "string cut" to """{"version":1,"host":"acme.example","cut":"no","fields":[$extractedPriceJson]}""",
            "not an object" to "\"acme.example\"",
            "null" to "null"
        )
        for ((case, extraction) in malformed) {
            val timeline = wireJson.decodeFromString<AidenGenerationTimeline>(extractTimelineJson(extraction))
            val step = timeline.steps[1]
            assertNull(case, step.extraction)
            assertEquals(case, "web_fetch", step.toolName)
            val rows = AidenChronologicalProjection.rows("Before.After.", "", timeline)!!
            assertTrue(case, rows.none { it.kind == AidenChronologicalRow.Kind.EXTRACTION })
        }

        // Boundary values the host accepts still decode.
        val boundary = extractRecapJson(
            """{"name":"pro","status":"uncertain","value":"${"😀".repeat(200)}"}""",
            *Array(15) { """{"name":"f$it","status":"null"}""" }
        )
        assertEquals(16, wireJson.decodeFromString<AidenGenerationTimeline>(extractTimelineJson(boundary))
            .steps[1].extractionRecap?.fields?.size)

        // A recap on another tool or an unfinished page is ignored.
        for ((toolName, status) in listOf("web_search" to "completed", "web_fetch" to "failed")) {
            val timeline = wireJson.decodeFromString<AidenGenerationTimeline>(
                extractTimelineJson(toolName = toolName, status = status)
            )
            assertNull(timeline.steps[1].extractionRecap)
            assertTrue(AidenAgentActivityPresentation.extractionSteps(timeline).isEmpty())
        }
    }

    private val recordingRecapJson =
        """{"id":"recording-0f1e2d3c-4b5a-4678-9abc-def012345678","mimeType":"video/mp4","durationMs":12400,"sizeBytes":1048576}"""

    private fun recordingTimelineJson(
        recording: String = recordingRecapJson,
        toolName: String = "browser_recording_stop",
        status: String = "completed"
    ) = """{"version":3,"generationId":"generation-recording","status":"completed","startedAt":1000,"finishedAt":2000,"steps":[""" +
        """{"id":"tool-1","order":0,"kind":"tool","toolCallId":"call-1","toolName":"browser_recording_start","label":"Start browser recording","status":"completed","startedAt":1000,"updatedAt":1100,"finishedAt":1100,"contentOffset":7},""" +
        """{"id":"tool-2","order":1,"kind":"tool","toolCallId":"call-2","toolName":"$toolName","label":"Stop browser recording","status":"$status","startedAt":1100,"updatedAt":1500,"finishedAt":1500,"contentOffset":7,"recording":$recording},""" +
        """{"id":"tool-3","order":2,"kind":"tool","toolCallId":"call-3","toolName":"read_file","label":"Read file","status":"completed","startedAt":1500,"updatedAt":1600,"finishedAt":1600,"contentOffset":7}]}"""

    @Test
    fun canonicalFixtureBrowserRecordingStepCarriesItsRecap() {
        val root = Json.parseToJsonElement(javaClass.classLoader!!.getResource("contract.json")!!.readText()).jsonObject
        assertTrue(root.getValue("contractRevision").jsonPrimitive.content.toInt() >= 46)
        val section = root.getValue("browserRecordings").jsonObject
        val step = wireJson.decodeFromJsonElement(AidenAgentStep.serializer(), section.getValue("step"))
        val recap = step.recordingRecap
        assertNotNull(recap)
        assertEquals("recording-0f1e2d3c-4b5a-4678-9abc-def012345678", recap!!.id)
        assertEquals("video/mp4", recap.mimeType)
        assertEquals("mp4", recap.fileExtension)
        assertEquals("0:12", recap.durationLabel)
        assertEquals("1.0 MB", recap.sizeLabel)
        // The route the Mac serves names the chat and the recap's own id.
        assertEquals(
            "/chats/chat_fixture_01/recordings/${recap.id}",
            section.getValue("recordingPath").jsonPrimitive.content
        )
    }

    @Test
    fun browserRecordingFollowsTheLineThatSavedItAndStaysInTheTally() {
        val timeline = wireJson.decodeFromString<AidenGenerationTimeline>(recordingTimelineJson())
        val recap = timeline.steps[1].recordingRecap
        assertNotNull(recap)
        assertEquals(12_400L, recap!!.durationMs)
        assertEquals(1_048_576L, recap.sizeBytes)

        val rows = AidenChronologicalProjection.rows("Before.After.", "", timeline)!!
        assertEquals(
            listOf("TEXT:Before.", "TOOL:tool-1,tool-2,tool-3", "RECORDING:tool-2", "TEXT:After."),
            rows.map { row -> "${row.kind}:${row.text.ifEmpty { row.steps.joinToString(",") { it.id } }}" }
        )
        assertEquals(recap, rows[2].recording)
        assertEquals(rows.size, rows.map { it.id }.toSet().size)

        // The stop stays an activity line, and fallback transcripts list its card.
        assertEquals(3, AidenAgentActivityPresentation.activityTimeline(timeline).steps.size)
        assertEquals(listOf("tool-2"), AidenAgentActivityPresentation.recordingSteps(timeline).map { it.id })
        assertTrue(AidenAgentActivityPresentation.extractionSteps(timeline).isEmpty())

        // The chat cache re-encodes the step; the recap survives the round trip.
        val cached = json.decodeFromString<AidenGenerationTimeline>(json.encodeToString(timeline))
        assertEquals(recap, cached.steps[1].recordingRecap)
        assertFalse(wireJson.encodeToString(timeline.steps[0]).contains("\"recording\":"))
    }

    @Test
    fun aPageReadAndARecordingInOneGroupEachFollowTheirOwnLine() {
        val timeline = wireJson.decodeFromString<AidenGenerationTimeline>(
            """{"version":3,"generationId":"generation-both","status":"completed","startedAt":1000,"finishedAt":2000,"steps":[""" +
                """{"id":"tool-1","order":0,"kind":"tool","toolCallId":"call-1","toolName":"browser_recording_stop","label":"Stop browser recording","status":"completed","startedAt":1000,"updatedAt":1100,"finishedAt":1100,"contentOffset":0,"recording":$recordingRecapJson},""" +
                """{"id":"tool-2","order":1,"kind":"tool","toolCallId":"call-2","toolName":"web_fetch","label":"Fetch web page","status":"completed","startedAt":1100,"updatedAt":1500,"finishedAt":1500,"contentOffset":0,"detail":"acme.example","extraction":${extractRecapJson(extractedPriceJson)}}]}"""
        )
        val rows = AidenChronologicalProjection.rows("Done.", "", timeline)!!
        assertEquals(
            listOf("TOOL:tool-1,tool-2", "RECORDING:tool-1", "EXTRACTION:tool-2", "TEXT:Done."),
            rows.map { row -> "${row.kind}:${row.text.ifEmpty { row.steps.joinToString(",") { it.id } }}" }
        )
    }

    @Test
    fun malformedOrMisplacedRecordingRecapIsDroppedButTheStopStaysAnActivityLine() {
        val id = "recording-0f1e2d3c-4b5a-4678-9abc-def012345678"
        fun recordingJson(
            recordingId: String = "\"$id\"",
            mimeType: String = "\"video/mp4\"",
            durationMs: String = "12400",
            sizeBytes: String = "1048576",
            extra: String = ""
        ) = """{"id":$recordingId,"mimeType":$mimeType,"durationMs":$durationMs,"sizeBytes":$sizeBytes$extra}"""
        val malformed = listOf(
            "uppercase hex in the id" to recordingJson(recordingId = "\"recording-0F1E2D3C-4b5a-4678-9abc-def012345678\""),
            "id without its prefix" to recordingJson(recordingId = "\"0f1e2d3c-4b5a-4678-9abc-def012345678\""),
            "id with a path" to recordingJson(recordingId = "\"recording-0f1e2d3c-4b5a-4678-9abc-def012345678/x\""),
            "numeric id" to recordingJson(recordingId = "7"),
            "quicktime" to recordingJson(mimeType = "\"video/quicktime\""),
            "uppercase type" to recordingJson(mimeType = "\"VIDEO/MP4\""),
            "type with parameters" to recordingJson(mimeType = "\"video/webm; codecs=vp9\""),
            "negative length" to recordingJson(durationMs = "-1"),
            "length over six minutes" to recordingJson(durationMs = "360001"),
            "fractional length" to recordingJson(durationMs = "12400.5"),
            "string length" to recordingJson(durationMs = "\"12400\""),
            "null length" to recordingJson(durationMs = "null"),
            "boolean size" to recordingJson(sizeBytes = "true"),
            "empty file" to recordingJson(sizeBytes = "0"),
            "file over 128 MiB" to recordingJson(sizeBytes = "134217729"),
            "size beyond a safe integer" to recordingJson(sizeBytes = "9007199254740993"),
            "an extra key" to recordingJson(extra = ""","path":"/Users/me/rec.mp4""""),
            "a missing key" to """{"id":"$id","mimeType":"video/mp4","durationMs":12400}""",
            "not an object" to "\"$id\"",
            "an array" to "[]",
            "null" to "null"
        )
        for ((case, recording) in malformed) {
            val timeline = wireJson.decodeFromString<AidenGenerationTimeline>(recordingTimelineJson(recording))
            val step = timeline.steps[1]
            assertNull(case, step.recording)
            assertEquals(case, "browser_recording_stop", step.toolName)
            val rows = AidenChronologicalProjection.rows("Before.After.", "", timeline)!!
            assertTrue(case, rows.none { it.kind == AidenChronologicalRow.Kind.RECORDING })
            assertEquals(case, listOf("tool-1", "tool-2", "tool-3"),
                rows.single { it.kind == AidenChronologicalRow.Kind.TOOL }.steps.map { it.id })
        }

        // Boundary values the desktop accepts still decode, including a whole number written as JSON reads it.
        val accepted = listOf(
            recordingJson(durationMs = "0", sizeBytes = "1"),
            recordingJson(durationMs = "360000", sizeBytes = "134217728"),
            recordingJson(mimeType = "\"video/webm\""),
            recordingJson(durationMs = "12400.0"),
            recordingJson(sizeBytes = "1.048576e6")
        )
        for (recording in accepted) {
            assertNotNull(recording, wireJson.decodeFromString<AidenGenerationTimeline>(recordingTimelineJson(recording))
                .steps[1].recordingRecap)
        }
        assertEquals("webm", wireJson.decodeFromString<AidenGenerationTimeline>(
            recordingTimelineJson(recordingJson(mimeType = "\"video/webm\""))
        ).steps[1].recordingRecap?.fileExtension)

        // A recap on another tool or an unfinished stop is ignored.
        for ((toolName, status) in listOf("browser_recording_start" to "completed", "browser_recording_stop" to "failed")) {
            val timeline = wireJson.decodeFromString<AidenGenerationTimeline>(
                recordingTimelineJson(toolName = toolName, status = status)
            )
            assertNull(timeline.steps[1].recordingRecap)
            assertTrue(AidenAgentActivityPresentation.recordingSteps(timeline).isEmpty())
            assertTrue(AidenChronologicalProjection.rows("Before.After.", "", timeline)!!
                .none { it.kind == AidenChronologicalRow.Kind.RECORDING })
        }
    }

    @Test
    fun recordingLabelsReadAsTheDesktopCardDoes() {
        val durations = listOf(
            0L to "0:00", 499L to "0:00", 500L to "0:01", 12_400L to "0:12",
            59_499L to "0:59", 59_500L to "1:00", 90_000L to "1:30", 360_000L to "6:00"
        )
        for ((milliseconds, label) in durations) {
            assertEquals("$milliseconds", label, AidenBrowserRecordingRecap.durationLabel(milliseconds))
        }
        val sizes = listOf(
            1L to "1 KB", 511L to "1 KB", 1_536L to "2 KB", 655_360L to "640 KB",
            1_048_575L to "1024 KB", 1_048_576L to "1.0 MB", 1_258_291L to "1.2 MB",
            1_310_720L to "1.3 MB", 134_217_728L to "128.0 MB"
        )
        for ((bytes, label) in sizes) {
            assertEquals("$bytes", label, AidenBrowserRecordingRecap.sizeLabel(bytes))
        }
    }

    @Test
    fun playReadsTheRecordingIntoTheCacheAndA404SaysItIsGone() {
        val directory = kotlin.io.path.createTempDirectory("aiden-recording-").toFile()
        val recordings = File(directory, "recordings")
        val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val server = MockWebServer()
        val viewModels = ViewModelStore()
        val scopeJob = Job()
        val present = "recording-0f1e2d3c-4b5a-4678-9abc-def012345678"
        val gone = "recording-11111111-2222-4333-8444-555555555555"
        val video = ByteArray(4_096) { (it % 251).toByte() }
        val initial = AidenChat(
            id = "chat-recording", workspaceId = "workspace-recording", title = "Recording",
            messages = listOf(AidenChatMessage("reply-one", AidenChatRole.ASSISTANT, "Recorded", createdAt = Instant.EPOCH)),
            createdAt = Instant.EPOCH, updatedAt = Instant.EPOCH, revision = "r1"
        )
        val grants = listOf(AidenRemoteCapability.SERVER_READ, AidenRemoteCapability.CHAT_READ)
        val wireJson = Json(json) { explicitNulls = false }
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl!!.encodedPath) {
                "/api/aiden/v1/server" -> MockResponse().setBody("""{"protocolVersion":1,"instanceId":"instance-recording","name":"Recording Mac","appVersion":"1.0","capabilities":${json.encodeToString(grants)},"serverCapabilities":${json.encodeToString(grants)},"features":["chat-browser-recordings-v1"],"connectionMode":"lan","serverTime":"2026-10-27T12:00:00Z"}""")
                "/api/aiden/v1/workspaces" -> MockResponse().setBody("""{"workspaces":[]}""")
                "/api/aiden/v1/chats/chat-recording" -> MockResponse().setBody(wireJson.encodeToString(initial))
                "/api/aiden/v1/chats/chat-recording/recordings/$present" -> MockResponse()
                    .setHeader("Content-Type", "video/mp4")
                    .setHeader("Cache-Control", "no-store")
                    .setHeader("X-Content-Type-Options", "nosniff")
                    .setBody(okio.Buffer().write(video))
                else -> MockResponse().setResponseCode(404).setHeader("Content-Type", "application/json")
                    .setBody("""{"error":{"code":"not_found","message":"Recording not found.","requestId":"req_1","retryable":false}}""")
            }
        }
        server.start()
        Dispatchers.setMain(dispatcher)
        try {
            runBlocking(dispatcher) {
                val installations = AidenInstallationStore(directory, InMemoryAidenSecureStore())
                installations.addInstallation(AidenPairingExchange(
                    instanceId = "instance-recording", deviceId = "device-recording", endpoint = server.url("/api/aiden/v1").toString(),
                    serverSpkiSha256 = "sha256/test", credential = "synthetic", capabilities = grants
                ), null)
                val cache = AidenChatCache(directory)
                val drafts = AidenChatDraftStore(directory)
                val coordinator = AidenRemoteCoordinator(
                    installations, directory, cache, drafts, scope = CoroutineScope(dispatcher + scopeJob),
                    browserRecordingDir = recordings
                )
                coordinator.refreshClient()
                withTimeout(5_000) { coordinator.serverInfo.first { it != null } }
                val model = AidenChatViewModel(initial.id, coordinator, cache, drafts, initial)
                viewModels.put("recording", model)
                assertTrue(model.canPlayBrowserRecordings)

                // A stale file from an earlier Play is dropped before the next one is read.
                recordings.mkdirs()
                File(recordings, "$gone.webm").writeBytes(byteArrayOf(1))
                val loaded = model.browserRecording(AidenBrowserRecordingRecap(present, "video/mp4", 12_400, video.size.toLong()))
                val ready = loaded as AidenBrowserRecordingLoad.Ready
                assertEquals("video/mp4", ready.recording.mimeType)
                assertEquals(File(recordings, "$present.mp4"), ready.recording.file)
                assertArrayEquals(video, ready.recording.file.readBytes())
                assertEquals(listOf("$present.mp4"), recordings.list()!!.sorted())

                assertEquals(
                    AidenBrowserRecordingLoad.Missing,
                    model.browserRecording(AidenBrowserRecordingRecap(gone, "video/mp4", 1_000, 10))
                )
                // Nothing is left behind for the recording the Mac no longer has.
                assertTrue(recordings.list()!!.isEmpty())
                viewModels.clearAndJoin()
            }
        } finally {
            scopeJob.cancel()
            Dispatchers.resetMain()
            dispatcher.close()
            server.shutdown()
            directory.deleteRecursively()
        }
    }

    private fun fixtureVisualMessage(): AidenChatMessage {
        val data = javaClass.classLoader!!.getResourceAsStream("contract.json")!!.bufferedReader().use { it.readText() }
        val chat = wireJson.decodeFromJsonElement(AidenChat.serializer(), Json.parseToJsonElement(data).jsonObject.getValue("chat"))
        return chat.messages.single { it.id == "message_fixture_assistant_01" }
    }

    private fun visualWireMessage(visuals: String): AidenChatMessage = wireJson.decodeFromString(
        """
            {"id":"message-visuals","role":"assistant","text":"Here it is.","createdAt":"2026-08-25T18:00:00.000Z",
             "attachments":[{"id":"visual-snapshot_aa","name":"Chart.png","mimeType":"image/png","kind":"image","size":10}],
             "visuals":$visuals}
        """.trimIndent()
    )

    @Test
    fun fixtureChatDecodesItsInlineVisualsInReplyOrder() {
        val message = fixtureVisualMessage()
        val visuals = message.visuals.orEmpty()
        assertEquals(listOf("artifact_fixture_01", "ui_fixture_01"), visuals.map { it.id })
        assertEquals(listOf("html", "ui"), visuals.map { it.kind })
        assertEquals(listOf("call-1", "call-2"), visuals.map { it.toolCallId })
        assertEquals("wide", visuals[0].layout)
        assertNull(visuals[1].layout)
        assertEquals("Plan options\nSolo: \$12.00\nTeam: \$60.00", visuals[1].fallbackText)
        assertTrue(message.isWireSafe)
    }

    @Test
    fun eachImageSitsBeneathTheStepThatProducedIt() {
        // Revision 44: an assistant image names the step that made it.
        val wire = """
            {"id":"m1","role":"assistant","text":"Before.Middle.After.","createdAt":"2026-08-18T19:00:01.000Z",
             "attachments":[
               {"id":"shared_a","name":"Shared.png","mimeType":"image/png","kind":"image","size":10,"toolCallId":"call-2"},
               {"id":"shown","name":"Shown.png","mimeType":"image/png","kind":"image","size":10,"toolCallId":"call-1"},
               {"id":"loose","name":"Loose.png","mimeType":"image/png","kind":"image","size":10},
               {"id":"odd","name":"Odd.png","mimeType":"image/png","kind":"image","size":10,"toolCallId":"call-0"},
               {"id":"typed","name":"Typed.png","mimeType":"image/png","kind":"image","size":10,"toolCallId":7}],
             "timeline":{"version":3,"generationId":"g","status":"completed","startedAt":1000,"finishedAt":2000,"steps":[
               {"id":"tool-1","order":0,"kind":"tool","toolCallId":"call-1","toolName":"display_image","label":"Display image","status":"completed","startedAt":1000,"updatedAt":1100,"finishedAt":1100,"contentOffset":7},
               {"id":"tool-2","order":1,"kind":"tool","toolCallId":"call-2","toolName":"share_image","label":"Share image","status":"completed","startedAt":1100,"updatedAt":1200,"finishedAt":1200,"contentOffset":14}]}}
        """.trimIndent()
        val message = json.decodeFromString<AidenChatMessage>(wire)
        val images = message.attachments.orEmpty()
        assertEquals(listOf("call-2", "call-1", null, null, null), images.map { it.placedToolCallId })
        assertTrue("a malformed step id never drops the image", message.isWireSafe)

        val rows = AidenChronologicalProjection.rows(message.text, "", message.timeline, images = images)!!
        assertEquals(
            listOf("TEXT:Before.", "TOOL:call-1", "IMAGES:shown", "TEXT:Middle.", "TOOL:call-2", "IMAGES:shared_a", "TEXT:After."),
            rows.map { row ->
                when (row.kind) {
                    AidenChronologicalRow.Kind.TEXT -> "TEXT:" + row.text
                    AidenChronologicalRow.Kind.TOOL -> "TOOL:" + row.steps.joinToString(",") { it.toolCallId.orEmpty() }
                    AidenChronologicalRow.Kind.IMAGES -> "IMAGES:" + row.images.joinToString(",") { it.id }
                    else -> "${row.kind}:"
                }
            }
        )
        assertEquals(rows.size, rows.map { it.id }.toSet().size)
        // Only images without a step are left for the strip after the reply.
        assertEquals(setOf("shown", "shared_a"), AidenChronologicalProjection.placedImageIds(rows))

        // While the reply streams, a generate_image placeholder sits beneath its step,
        // split from the next step exactly as its image will be once the reply commits,
        // so nothing moves at the hand-off.
        val live = json.decodeFromString<AidenGenerationTimeline>(
            """{"version":3,"generationId":"g","status":"running","startedAt":1000,"steps":[{"id":"tool-1","order":0,"kind":"tool","toolCallId":"call-1","toolName":"generate_image","label":"Generate image","status":"completed","startedAt":1000,"updatedAt":1100,"finishedAt":1100,"contentOffset":7},{"id":"tool-2","order":1,"kind":"tool","toolCallId":"call-2","toolName":"web_search","label":"Search","status":"running","startedAt":1100,"updatedAt":1200,"contentOffset":7}]}"""
        )
        fun describe(rows: List<AidenChronologicalRow>) = rows.map { row ->
            when (row.kind) {
                AidenChronologicalRow.Kind.TEXT -> "TEXT:" + row.text
                AidenChronologicalRow.Kind.TOOL -> "TOOL:" + row.steps.joinToString(",") { it.toolCallId.orEmpty() }
                AidenChronologicalRow.Kind.IMAGES -> "IMAGES:" + row.images.joinToString(",") { it.id }
                AidenChronologicalRow.Kind.IMAGE_SLOT -> "SLOT:" + row.imageSlot
                else -> "${row.kind}:"
            }
        }
        val liveRows = AidenChronologicalProjection.rows("Before.Here it is.", "", live, imageSlots = listOf("call-1", "call-7"))!!
        assertEquals(
            listOf("TEXT:Before.", "TOOL:call-1", "SLOT:call-1", "TOOL:call-2", "TEXT:Here it is."),
            describe(liveRows)
        )
        assertEquals(setOf("call-1"), AidenChronologicalProjection.placedImageSlots(liveRows))
        val generated = AidenMessageAttachment(
            id = "generated", name = "Image.png", mimeType = "image/png", kind = AidenAttachmentKind.IMAGE, size = 10,
            toolCallId = "call-1"
        )
        assertEquals(
            listOf("TEXT:Before.", "TOOL:call-1", "IMAGES:generated", "TOOL:call-2", "TEXT:Here it is."),
            describe(AidenChronologicalProjection.rows("Before.Here it is.", "", live, images = listOf(generated))!!)
        )
    }

    @Test
    fun eachVisualFollowsTheToolStepThatDrewItAndUnmatchedVisualsTrail() {
        val message = fixtureVisualMessage()
        val rows = AidenChronologicalProjection.rows(
            message.text, message.reasoning.orEmpty(), message.timeline, message.visuals.orEmpty()
        )!!
        // Both tool steps share content offset 0, yet each visual sits right after its own step.
        assertEquals(
            listOf("TOOL:call-1", "VISUAL:artifact_fixture_01", "TOOL:call-2", "VISUAL:ui_fixture_01", "TEXT:"),
            rows.map { row ->
                when (row.kind) {
                    AidenChronologicalRow.Kind.TOOL -> "TOOL:" + row.steps.joinToString(",") { it.toolCallId.orEmpty() }
                    AidenChronologicalRow.Kind.VISUAL -> "VISUAL:" + row.visual?.id
                    else -> "${row.kind}:"
                }
            }
        )
        assertEquals(rows.size, rows.map { it.id }.toSet().size)

        val orphan = AidenChatVisual(id = "ui_orphan", kind = "ui", title = "Orphan", toolCallId = "call-9")
        val trailing = AidenChronologicalProjection.rows(
            message.text, "", message.timeline, message.visuals.orEmpty() + orphan
        )!!
        assertEquals(AidenChronologicalRow.Kind.VISUAL, trailing.last().kind)
        assertEquals("ui_orphan", trailing.last().visual?.id)
        // Without visuals, the steps group as before.
        assertEquals(
            listOf(AidenChronologicalRow.Kind.TOOL, AidenChronologicalRow.Kind.TEXT),
            AidenChronologicalProjection.rows(message.text, "", message.timeline)?.map { it.kind }
        )
    }

    @Test
    fun malformedVisualIsDroppedWithoutLosingItsMessage() {
        val message = visualWireMessage(
            """
            [
              {"id":"ui_untitled","kind":"ui"},
              {"id":"ui_kind","kind":"chart","title":"Bad kind"},
              {"id":"ui_call","kind":"ui","title":"Bad call","toolCallId":"tool-1"},
              {"id":"ui_layout","kind":"ui","title":"Bad layout","layout":"narrow"},
              {"id":"ui_long","kind":"ui","title":"Long","fallbackText":"${"x".repeat(4_001)}"},
              "not an object",
              {"id":"html_ok","kind":"html","title":"Chart","snapshotAttachmentId":"visual-snapshot_aa","futureKey":1},
              {"id":"html_ok","kind":"html","title":"Duplicate"}
            ]
            """.trimIndent()
        )
        assertEquals("Here it is.", message.text)
        assertEquals(listOf("html_ok"), message.visuals?.map { it.id })
        assertEquals("Chart", message.visuals?.single()?.title)
        assertTrue(message.isWireSafe)

        val chat = AidenChat(
            id = "chat-visuals", workspaceId = "workspace-1", title = "Visuals", messages = listOf(message),
            createdAt = Instant.EPOCH, updatedAt = Instant.EPOCH, revision = "rev_1"
        )
        assertEquals(1, chat.messages.size)
    }

    @Test
    fun moreThanFortyVisualsFailTheMessage() {
        val forty = (1..40).map { AidenChatVisual(id = "ui_$it", kind = "ui", title = "Visual $it") }
        val base = AidenChatMessage("message-1", AidenChatRole.ASSISTANT, "Text", createdAt = Instant.EPOCH)
        assertTrue(base.copy(visuals = forty).isWireSafe)
        assertFalse(base.copy(visuals = forty + AidenChatVisual(id = "ui_41", kind = "ui", title = "Visual 41")).isWireSafe)
    }

    @Test
    fun snapshotAttachmentsNeverReachTheOrdinaryAttachmentList() {
        val message = fixtureVisualMessage()
        val photo = AidenMessageAttachment("photo-1", "Photo.png", "image/png", AidenAttachmentKind.IMAGE, 1_024)
        val namedSnapshot = AidenMessageAttachment("named-snapshot", "Named.png", "image/png", AidenAttachmentKind.IMAGE, 1_024)
        val strayPrefixed = AidenMessageAttachment(
            "visual-snapshot_${"3".repeat(64)}", "Stray.png", "image/png", AidenAttachmentKind.IMAGE, 1_024
        )
        val notes = AidenMessageAttachment("notes", "notes.txt", "text/plain", AidenAttachmentKind.TEXT, 12)
        val visuals = message.visuals.orEmpty() +
            AidenChatVisual(id = "ui_named", kind = "ui", title = "Named", snapshotAttachmentId = "named-snapshot")
        val attachments = message.attachments.orEmpty() + photo + namedSnapshot + strayPrefixed + notes

        assertEquals(listOf(photo), aidenEligibleImageAttachments(attachments, visuals))
        assertEquals(listOf(photo, notes), aidenVisibleMessageAttachments(attachments, visuals))
        // A message without visuals keeps every ordinary image.
        assertEquals(listOf(photo, namedSnapshot), aidenEligibleImageAttachments(listOf(photo, namedSnapshot)))
    }

    @Test
    fun visualRowShowsSnapshotThenFallbackTextThenTitle() {
        val message = fixtureVisualMessage()
        val attachments = message.attachments.orEmpty()
        val (html, ui) = message.visuals.orEmpty()

        val htmlDisplay = aidenVisualDisplay(html, attachments)
        assertEquals(html.snapshotAttachmentId, htmlDisplay.snapshot?.id)
        assertNull(htmlDisplay.text)

        val uiDisplay = aidenVisualDisplay(ui, attachments)
        assertEquals(ui.snapshotAttachmentId, uiDisplay.snapshot?.id)
        assertEquals(ui.fallbackText, uiDisplay.text)

        // A snapshot the message does not carry is no snapshot at all.
        val fallbackOnly = aidenVisualDisplay(ui, emptyList())
        assertNull(fallbackOnly.snapshot)
        assertEquals(ui.fallbackText, fallbackOnly.text)

        val titleOnly = aidenVisualDisplay(html, emptyList())
        assertNull(titleOnly.snapshot)
        assertEquals("Weekly total", titleOnly.text)
    }

    @Test
    fun htmlVisualWithoutASnapshotIsLeftToItsUnsupportedNotice() {
        val message = fixtureVisualMessage()
        val (html, ui) = message.visuals.orEmpty()
        // With snapshots, both visuals get rows.
        assertEquals(listOf(html.id, ui.id), aidenVisualsWithRows(message).map { it.id })

        // Without one, the html visual is represented only by its notice; the ui visual keeps its fallback row.
        val noSnapshots = message.copy(attachments = emptyList())
        assertEquals(listOf(ui.id), aidenVisualsWithRows(noSnapshots).map { it.id })
        assertEquals(listOf(html.id), aidenUnsupportedHtmlArtifacts(noSnapshots).map { it.id })

        // A ui visual with neither snapshot nor fallback text still shows its title.
        val bareUi = noSnapshots.copy(visuals = listOf(ui.copy(fallbackText = null)))
        assertEquals(listOf(ui.id), aidenVisualsWithRows(bareUi).map { it.id })

        // The chronological transcript built from those visuals carries no html row either.
        val rows = AidenChronologicalProjection.rows(
            noSnapshots.text, "", noSnapshots.timeline, aidenVisualsWithRows(noSnapshots)
        )!!
        assertEquals(listOf(ui.id), rows.mapNotNull { it.visual?.id })
    }

    @Test
    fun lateSnapshotRefreshRetriesBrieflyForTheNewestReplyStillMissingOne() {
        val policy = AidenVisualSnapshotRefreshPolicy()
        val settled = fixtureVisualMessage()
        val pending = settled.copy(attachments = emptyList())
        val soon = pending.createdAt.plusSeconds(5)

        // Every visual already has its snapshot: nothing to wait for.
        assertNull(policy.nextDelayMillis(settled, attempt = 0, now = soon))
        // Missing snapshots: three bounded re-reads, then stop. Measured from settlement the
        // re-reads land at 4 s, 10 s and 20 s, the same schedule iOS uses.
        val waits = (0..3).map { policy.nextDelayMillis(pending, it, soon) }
        assertNull(waits.last())
        assertEquals(listOf(4_000L, 10_000L, 20_000L), waits.filterNotNull().runningReduce { elapsed, wait -> elapsed + wait })
        // One visual still missing its snapshot is enough to retry.
        val partial = settled.copy(attachments = settled.attachments.orEmpty().take(1))
        assertEquals(4_000L, policy.nextDelayMillis(partial, 0, soon))
        // An old reply is not polled for.
        assertNull(policy.nextDelayMillis(pending, 0, pending.createdAt.plusSeconds(180)))
        // A long turn counts from when it finished, not from when it started.
        val finishedRecently = pending.copy(
            createdAt = pending.createdAt.minusSeconds(600),
            timeline = pending.timeline!!.copy(finishedAt = soon.minusSeconds(10).toEpochMilli().toDouble())
        )
        assertEquals(4_000L, policy.nextDelayMillis(finishedRecently, 0, soon))
        // No visuals, a user message, or no message: nothing to do.
        assertNull(policy.nextDelayMillis(pending.copy(visuals = null), 0, soon))
        assertNull(policy.nextDelayMillis(pending.copy(role = AidenChatRole.USER), 0, soon))
        assertNull(policy.nextDelayMillis(null, 0, soon))

        // Only the newest assistant reply is watched.
        val later = AidenChatMessage("reply-later", AidenChatRole.ASSISTANT, "No visuals", createdAt = soon)
        val question = AidenChatMessage("question", AidenChatRole.USER, "Thanks", createdAt = soon)
        assertEquals(pending.id, policy.watchedMessage(listOf(pending, question))?.id)
        assertEquals(later.id, policy.watchedMessage(listOf(pending, question, later))?.id)
    }

    @Test
    fun htmlArtifactNoticeIsSuppressedOnlyWhenItsVisualHasASnapshot() {
        val message = fixtureVisualMessage()
        assertEquals(emptyList<AidenHtmlArtifact>(), aidenUnsupportedHtmlArtifacts(message))

        val withoutSnapshot = message.copy(visuals = message.visuals?.map { it.copy(snapshotAttachmentId = null) })
        assertEquals(listOf("artifact_fixture_01"), aidenUnsupportedHtmlArtifacts(withoutSnapshot).map { it.id })

        val snapshotMissing = message.copy(attachments = emptyList())
        assertEquals(listOf("artifact_fixture_01"), aidenUnsupportedHtmlArtifacts(snapshotMissing).map { it.id })

        val noVisuals = message.copy(visuals = null)
        assertEquals(listOf("artifact_fixture_01"), aidenUnsupportedHtmlArtifacts(noVisuals).map { it.id })
    }

    @Test
    fun coldReplayRebuildsPrefixWarmReconnectUsesMemoryAndTerminalRejectsLateEvents() = assertStreamRecovery()

    @Test
    fun heldInitialLoadCannotOverwriteSettledTranscriptOrCache() = assertStreamRecovery(holdInitialLoad = true)

    @Test
    fun anotherOwnersHeldLoadCannotOverwriteSettledTranscriptOrCache() =
        assertStreamRecovery(holdInitialLoad = true, independentOwner = true)

    @Test
    fun anotherOwnersHeldLoadAdoptsWinnerWhenDiskWriteFails() =
        assertStreamRecovery(holdInitialLoad = true, independentOwner = true, failDiskWrite = true)

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private fun assertStreamRecovery(holdInitialLoad: Boolean = false, independentOwner: Boolean = false, failDiskWrite: Boolean = false) {
        val directory = kotlin.io.path.createTempDirectory("aiden-stream-recovery-").toFile()
        val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val server = MockWebServer()
        val viewModels = ViewModelStore()
        val requests = java.util.Collections.synchronizedList(mutableListOf<String>())
        val chatReads = java.util.concurrent.atomic.AtomicInteger()
        val eventReads = java.util.concurrent.atomic.AtomicInteger()
        val releaseInitialLoad = CountDownLatch(1)
        val initialLoadArrived = CountDownLatch(1)
        val initial = AidenChat(
            id = "chat-recovery", workspaceId = "workspace-recovery", title = "Recovery",
            messages = emptyList(), createdAt = Instant.EPOCH, updatedAt = Instant.EPOCH, revision = "r1"
        )
        // Match the host's public projection: absent optional private fields
        // must be omitted, not serialized as forbidden `reasoning: null` keys.
        val wireJson = Json(json) { explicitNulls = false }
        val final = initial.copy(messages = listOf(AidenChatMessage(
            id = "final-reply", role = AidenChatRole.ASSISTANT, text = "Authoritative final", createdAt = Instant.EPOCH
        )))
        fun event(sequence: Int, type: String, payload: String, terminal: Boolean = false) =
            "id: $sequence\nevent: $type\ndata: {\"protocolVersion\":1,\"streamId\":\"stream-recovery\",\"sequence\":$sequence,\"timestamp\":\"2026-09-22T00:00:00Z\",\"type\":\"$type\",\"terminal\":$terminal,\"payload\":$payload}\n\n"
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                requests.add(request.path!!)
                return when {
                    path.endsWith("/events") -> {
                        val body = if (eventReads.incrementAndGet() == 1) {
                            event(1, "text_delta", "{\"text\":\"prefix \"}")
                        } else {
                            event(2, "text_delta", "{\"text\":\"suffix\"}") +
                                event(3, "done", "{\"messageId\":\"reply\"}", true) +
                                event(4, "text_delta", "{\"text\":\"LATE\"}")
                        }
                        MockResponse().setHeader("Content-Type", "text/event-stream").setBody(body)
                    }
                    path.endsWith("/streams/stream-recovery") -> MockResponse().setBody(
                        """{"streamId":"stream-recovery","chatId":"chat-recovery","turnId":"turn-recovery","state":"running","lastSequence":1}"""
                    )
                    path.endsWith("/chats/chat-recovery") && chatReads.incrementAndGet() == 1 -> {
                        initialLoadArrived.countDown()
                        if (holdInitialLoad) check(releaseInitialLoad.await(10, TimeUnit.SECONDS))
                        MockResponse().setBody(wireJson.encodeToString(initial))
                    }
                    path.endsWith("/chats/chat-recovery") && holdInitialLoad ->
                        MockResponse().setBody(wireJson.encodeToString(final))
                    else -> MockResponse().setResponseCode(503).setBody(
                        """{"error":{"code":"internal_error","message":"Offline transcript","requestId":"r","retryable":true}}"""
                    )
                }
            }
        }
        server.start()
        Dispatchers.setMain(dispatcher)
        try {
            runBlocking(dispatcher) {
                val installations = AidenInstallationStore(directory, InMemoryAidenSecureStore())
                installations.addInstallation(AidenPairingExchange(
                    instanceId = "instance-recovery", deviceId = "device-recovery",
                    endpoint = server.url("/api/aiden/v1").toString(), serverSpkiSha256 = "sha256/test",
                    credential = "synthetic", capabilities = listOf(AidenRemoteCapability.CHAT_READ)
                ), null)
                val cache = AidenChatCache(directory)
                cache.saveChat(initial, "instance-recovery")
                val drafts = AidenChatDraftStore(directory)
                val coordinator = AidenRemoteCoordinator(installations, directory, cache, drafts,
                    scope = CoroutineScope(dispatcher + Job().apply { cancel() }))
                coordinator.refreshClient()
                val otherOwner = if (independentOwner) {
                    AidenChatViewModel(initial.id, coordinator, cache, drafts, initial).also {
                        viewModels.put("other", it)
                        withContext(Dispatchers.IO) { check(initialLoadArrived.await(5, TimeUnit.SECONDS)) }
                    }
                } else null
                cache.saveActiveStream(AidenChatCache.ActiveStream("device-recovery", "stream-recovery", "turn-recovery", 27), "instance-recovery", initial.id)
                if (failDiskWrite) {
                    File(cache.root, "chats").apply { deleteRecursively(); writeText("blocked directory") }
                }
                val model = AidenChatViewModel(initial.id, coordinator, cache, drafts, initial)
                viewModels.put("chat", model)
                // Sample between every task on the main thread, where Compose
                // reads state for a frame: the reply must always be on screen
                // exactly once, as the live card or as the final message.
                // With an independent owner holding the first read, this
                // model's own initial load is served the final transcript while
                // the stream is still replaying, so only the variants where the
                // reply can arrive solely through completion are checked.
                val handoffViolations = mutableListOf<String>()
                val handoffSampler = launch {
                    while (isActive) {
                        val hasFinal = model.chat.value?.messages?.any { it.id == "final-reply" } == true
                        val hasLiveCard = model.liveText.value.isNotEmpty()
                        val ended = model.streamState.value?.isTerminal == true
                        if (hasFinal && hasLiveCard) handoffViolations += "both"
                        if (ended && !hasFinal && !hasLiveCard) handoffViolations += "neither"
                        yield()
                    }
                }
                withTimeout(8_000) { model.streamState.first { it == AidenStreamState.DONE } }
                if (holdInitialLoad) {
                    withTimeout(5_000) { model.hasActiveStream.first { !it } }
                    assertEquals("final-reply", model.chat.value!!.messages.last().id)
                    releaseInitialLoad.countDown()
                    withTimeout(5_000) { model.isLoading.first { !it } }
                    assertEquals("final-reply", model.chat.value!!.messages.last().id)
                    assertEquals("final-reply", cache.admittedChat("instance-recovery", initial.id)!!.messages.last().id)
                    if (otherOwner != null) {
                        withTimeout(5_000) { otherOwner.isLoading.first { !it } }
                        assertEquals("final-reply", otherOwner.chat.value!!.messages.lastOrNull()?.id)
                        if (failDiskWrite) assertNull(AidenChatCache(directory).loadChat("instance-recovery", initial.id))
                        else assertEquals("final-reply", AidenChatCache(directory).loadChat("instance-recovery", initial.id)!!.messages.lastOrNull()?.id)
                        otherOwner.updateDraft("Continue from another destination")
                        assertTrue(otherOwner.canSend)
                    }
                    assertEquals("", model.liveText.value)
                } else {
                    // Let the terminal reconciliation attempt and any illegally queued late frame run.
                    withTimeout(5_000) { model.presentedError.first { it == "Offline transcript" } }
                    kotlinx.coroutines.delay(100)
                    assertEquals("prefix suffix", model.liveText.value)
                }
                val eventPaths = synchronized(requests) { requests.filter { it.contains("/events") } }
                assertEquals(2, eventPaths.size)
                assertFalse(eventPaths[0].contains("after="))
                assertTrue(eventPaths[1].endsWith("after=1"))
                assertEquals(if (holdInitialLoad) null else 27, AidenChatCache(directory).loadActiveStream("instance-recovery", initial.id)?.lastSequence)
                assertEquals(AidenStreamState.DONE, model.streamState.value)
                handoffSampler.cancel()
                if (!independentOwner) assertEquals(emptyList<String>(), handoffViolations.distinct())
                model.updateDraft("Next turn")
                assertEquals(holdInitialLoad, model.canSend)
                assertTrue(requests.none { it.endsWith("/turns") })
            }
        } finally {
            releaseInitialLoad.countDown()
            runBlocking(dispatcher) { viewModels.clearAndJoin() }
            Dispatchers.resetMain()
            dispatcher.close()
            server.shutdown()
            directory.deleteRecursively()
        }
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun heldTurnReceiptPreservesOtherOwnerAndCannotCrossRemoval() {
        val main = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        Dispatchers.setMain(main)
        try {
            runBlocking(main) {
                for (mode in listOf("newer", "missing", "newer_post", "purge", "remove", "disk", "stream_disk", "replace_disk", "unpair", "switch", "repair", "inverse", "inverse_missing", "ordered_posts")) {
                    val root = kotlin.io.path.createTempDirectory("aiden-turn-owner-").toFile()
                    val server = MockWebServer()
                    val owners = ViewModelStore()
                    val arrived = CountDownLatch(1)
                    val release = CountDownLatch(1)
                    val secondPostArrived = CountDownLatch(1)
                    val getArrived = CountDownLatch(1)
                    val getRelease = CountDownLatch(1)
                    val postCount = java.util.concurrent.atomic.AtomicInteger()
                    val initial = sampleChat().copy(messages = emptyList())
                    val accepted = AidenChatMessage("accepted-user", AidenChatRole.USER, "Hello", createdAt = Instant.EPOCH)
                    val second = accepted.copy(id = "second-user", text = "Second", createdAt = Instant.EPOCH.plusSeconds(2))
                    val settled = initial.copy(title = "Settled title", revision = "settled-revision", messages = listOf(accepted,
                        AidenChatMessage("settled-assistant", AidenChatRole.ASSISTANT, "Final", createdAt = Instant.EPOCH.plusSeconds(1))))
                    val remote = java.util.concurrent.atomic.AtomicReference(initial)
                    server.dispatcher = object : Dispatcher() {
                        override fun dispatch(request: RecordedRequest): MockResponse = when {
                            request.requestUrl!!.encodedPath.endsWith("/turns") -> {
                                val count = postCount.incrementAndGet()
                                if (count == 1) { arrived.countDown(); check(release.await(8, TimeUnit.SECONDS)) }
                                if (count == 2 && mode == "ordered_posts") { secondPostArrived.countDown(); check(getRelease.await(8, TimeUnit.SECONDS)) }
                                MockResponse().setResponseCode(202).setBody("""{"turnId":"accepted-turn-$count","streamId":"accepted-stream-$count","status":"queued","message":${wireJson.encodeToString(if (count == 1) accepted else second)}}""")
                            }
                            request.requestUrl!!.encodedPath.endsWith("/events") -> MockResponse().setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.NO_RESPONSE)
                            request.requestUrl!!.encodedPath.endsWith("/chats/" + initial.id) -> {
                                val snapshot = remote.get()
                                if (mode.startsWith("inverse") && snapshot != initial) {
                                    getArrived.countDown(); check(getRelease.await(8, TimeUnit.SECONDS))
                                }
                                MockResponse().setBody(wireJson.encodeToString(snapshot))
                            }
                            else -> MockResponse().setResponseCode(404)
                        }
                    }
                    server.start()
                    try {
                        val store = AidenInstallationStore(root, InMemoryAidenSecureStore())
                        store.addInstallation(AidenPairingExchange(instanceId = "turn-instance", deviceId = "turn-device",
                            endpoint = server.url("/api/aiden/v1").toString(), serverSpkiSha256 = "sha256/test", credential = "synthetic",
                            capabilities = listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.CHAT_WRITE)), null)
                        var failStreamWrite = false
                        val cache = AidenChatCache(root = File(root, "cache"), beforeActiveStreamWrite = {
                            if (failStreamWrite) throw java.io.IOException("held stream persistence failure")
                        })
                        val drafts = AidenChatDraftStore(root)
                        val coordinator = AidenRemoteCoordinator(store, root, cache, drafts, scope = CoroutineScope(main + Job().apply { cancel() }))
                        coordinator.refreshClient()
                        val sender = AidenChatViewModel(initial.id, coordinator, cache, drafts, initial)
                        owners.put("sender", sender)
                        yield(); withTimeout(5_000) { sender.isLoading.first { !it } }
                        sender.updateDraft("Hello")
                        assertTrue(sender.canSend)
                        sender.send()
                        withContext(Dispatchers.IO) { check(arrived.await(5, TimeUnit.SECONDS)) }
                        remote.set(if (mode in listOf("missing", "inverse_missing", "ordered_posts")) settled.copy(messages = settled.messages.drop(1)) else settled)
                        val other = AidenChatViewModel(initial.id, coordinator, cache, drafts, initial)
                        owners.put("other", other)
                        if (mode.startsWith("inverse")) {
                            withContext(Dispatchers.IO) { check(getArrived.await(5, TimeUnit.SECONDS)) }
                            release.countDown()
                            withTimeout(5_000) { sender.isStarting.first { !it } }
                            getRelease.countDown()
                        }
                        yield(); withTimeout(5_000) { other.isLoading.first { !it } }
                        assertEquals("settled-assistant", other.chat.value!!.messages.last().id)
                        if (mode in listOf("newer_post", "ordered_posts")) {
                            other.updateDraft("Second")
                            assertFalse("A second view must retain the unresolved original attempt", other.canSend)
                            other.send()
                            assertFalse(other.isStarting.value)
                            other.discardPendingSend()
                            withTimeout(5_000) { other.pendingSend.first { it == null } }
                            assertTrue(other.canSend)
                            other.send()
                            if (mode == "ordered_posts") {
                                withContext(Dispatchers.IO) { check(secondPostArrived.await(5, TimeUnit.SECONDS)) }
                                release.countDown()
                                withTimeout(5_000) { sender.isStarting.first { !it } }
                                getRelease.countDown()
                            }
                            yield(); withTimeout(5_000) { other.isStarting.first { !it } }
                            assertEquals("accepted-stream-2", cache.loadActiveStream("turn-instance", initial.id)?.streamId)
                        }
                        when (mode) {
                            "unpair" -> store.removeInstallation("turn-instance")
                            "switch" -> { store.setActiveInstallation(null); coordinator.refreshClient() }
                            "repair" -> store.addInstallation(AidenPairingExchange(instanceId = "turn-instance", deviceId = "turn-device",
                                endpoint = server.url("/api/aiden/v1").toString(), serverSpkiSha256 = "sha256/test", credential = "replacement",
                                capabilities = listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.CHAT_WRITE)), null)
                            "replace_disk" -> {
                                cache.saveActiveStream(AidenChatCache.ActiveStream("turn-device", "old-stream", "old-turn", 0), "turn-instance", initial.id)
                                assertEquals("old-stream", AidenChatCache(root = File(root, "cache")).loadActiveStream("turn-instance", initial.id)?.streamId)
                                failStreamWrite = true
                            }
                            "purge" -> cache.purge("turn-instance")
                            "remove" -> { cache.removeChat("turn-instance", initial.id); cache.saveChat(initial.copy(title = "Fresh readmission"), "turn-instance") }
                            "disk" -> File(cache.root, "chats").apply { deleteRecursively(); writeText("blocked directory") }
                            "stream_disk" -> File(cache.root, "streams").apply { deleteRecursively(); writeText("blocked directory") }
                        }
                        release.countDown()
                        withTimeout(5_000) { sender.isStarting.first { !it } }
                        if (mode == "switch") {
                            val reopenedDrafts = AidenChatDraftStore(root)
                            assertNull(reopenedDrafts.loadPendingSend(reopenedDrafts.beginSession("turn-instance", initial.id), "turn-device"))
                        }
                        val reopened = AidenChatCache(root = File(root, "cache"))
                        if (mode == "ordered_posts") {
                            assertEquals(settled.messages + second, other.chat.value!!.messages)
                            assertEquals(settled.messages + second, reopened.loadChat("turn-instance", initial.id)!!.messages)
                            assertEquals("accepted-stream-2", cache.loadActiveStream("turn-instance", initial.id)?.streamId)
                        } else if (mode.startsWith("inverse")) {
                            assertEquals(settled.messages, other.chat.value!!.messages)
                            assertEquals(settled.title, other.chat.value!!.title)
                            assertEquals(settled, reopened.loadChat("turn-instance", initial.id))
                            assertEquals("accepted-stream-1", cache.loadActiveStream("turn-instance", initial.id)?.streamId)
                            assertEquals("accepted-stream-1", reopened.loadActiveStream("turn-instance", initial.id)?.streamId)
                            assertNull(sender.presentedError.value)
                            assertEquals("", sender.draft.value)
                            assertEquals(settled.title, cache.loadSummaries("turn-instance")!!.first { it.id == initial.id }.title)
                        } else if (mode in listOf("unpair", "switch", "repair")) {
                            assertFalse(sender.hasActiveStream.value)
                            assertEquals(settled.messages, sender.chat.value!!.messages)
                            assertEquals(if (mode == "switch") "accepted-stream-1" else null, cache.loadActiveStream("turn-instance", initial.id)?.streamId)
                            assertNull(sender.presentedError.value)
                            assertEquals("", sender.draft.value)
                        } else if (mode !in listOf("purge", "remove")) {
                            val expectedMessages = if (mode == "newer_post") settled.messages + second else settled.messages
                            assertEquals(expectedMessages, sender.chat.value!!.messages)
                            assertEquals(settled.revision, sender.chat.value!!.revision)
                            val expectedStream = if (mode == "newer_post") "accepted-stream-2" else "accepted-stream-1"
                            assertEquals(expectedStream, cache.loadActiveStream("turn-instance", initial.id)?.streamId)
                            assertEquals(if (mode in listOf("stream_disk", "replace_disk")) null else expectedStream, reopened.loadActiveStream("turn-instance", initial.id)?.streamId)
                            assertTrue(sender.hasActiveStream.value)
                            assertNull(sender.presentedError.value)
                            assertEquals("", sender.draft.value)
                            if (mode == "newer") assertEquals(settled.messages, reopened.loadChat("turn-instance", initial.id)?.messages)
                        } else {
                            assertNull(reopened.loadActiveStream("turn-instance", initial.id))
                            assertFalse(sender.hasActiveStream.value)
                            assertEquals(if (mode == "remove") "Fresh readmission" else null, reopened.loadChat("turn-instance", initial.id)?.title)
                        }
                        assertEquals(if (mode in listOf("newer_post", "ordered_posts")) 2 else 1, postCount.get())
                    } finally { release.countDown(); getRelease.countDown(); owners.clearAndJoin(); server.shutdown(); root.deleteRecursively() }
                }
            }
        } finally { Dispatchers.resetMain(); main.close() }
    }

    @Test
    fun receiptOverlayRetiresAtFreshSnapshotAndDoesNotCrossDeletion() {
        val root = kotlin.io.path.createTempDirectory("aiden-receipt-overlay-").toFile()
        try {
            val cache = AidenChatCache(root = root)
            val chat = sampleChat().copy(messages = emptyList())
            val receipt = AidenChatMessage("accepted", AidenChatRole.USER, "Accepted", createdAt = Instant.EPOCH)
            val stream = AidenChatCache.ActiveStream("device", "stream", "turn", 0)
            for (mode in listOf("fresh", "remove", "purge")) {
                val instance = "overlay-$mode"
                cache.saveChat(chat, instance)
                val post = cache.reserveChatWrite()
                val heldGet = cache.reserveChatWrite()
                cache.acceptTurnReceipt(chat, receipt, stream, instance, post)
                assertTrue(cache.saveChat(chat, instance, heldGet))
                assertEquals(listOf(receipt), cache.admittedChat(instance, chat.id)!!.messages)
                when (mode) {
                    "remove" -> cache.removeChat(instance, chat.id)
                    "purge" -> cache.purge(instance)
                }
                val fresh = chat.copy(title = "Fresh snapshot", revision = "fresh")
                assertTrue(cache.saveChat(fresh, instance, cache.reserveChatWrite()))
                assertEquals(fresh, cache.admittedChat(instance, chat.id))
                assertFalse(cache.saveChat(chat, instance, heldGet))
                assertEquals(fresh, AidenChatCache(root = root).loadChat(instance, chat.id))
            }
        } finally { root.deleteRecursively() }
    }

    @Test
    fun failedSendRestoresDurableDraftAfterRestart() = assertFailedSendDraft()

    @Test
    fun failedSendPersistsSubmittedTextAndNewerEdits() = assertFailedSendDraft(newerText = "Newer unsent text")

    @Test
    fun failedSendCannotRestoreDraftAfterInstallationPurge() = assertFailedSendDraft(purgeWhileSending = true)

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test fun selectedAttachmentPreparationKeepsMainResponsiveAndSendReservedThroughCancellation() =
        assertFailedSendDraft(checkPreparation = true)

    private fun assertFailedSendDraft(newerText: String = "", purgeWhileSending: Boolean = false, checkPreparation: Boolean = false) {
        val directory = kotlin.io.path.createTempDirectory("aiden-failed-send-").toFile()
        val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val turnArrived = CountDownLatch(1)
        val releaseTurn = CountDownLatch(1)
        val sendKeys = java.util.concurrent.CopyOnWriteArrayList<String?>()
        val server = MockWebServer()
        val viewModels = ViewModelStore()
        val initialChat = AidenChat(
            id = "chat-draft", workspaceId = "workspace-draft", title = "Draft recovery",
            messages = emptyList(), createdAt = Instant.EPOCH, updatedAt = Instant.EPOCH,
            revision = "revision-draft"
        )
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/api/aiden/v1/chats/chat-draft/turns" -> {
                    assertEquals("POST", request.method)
                    sendKeys.add(request.getHeader("Idempotency-Key"))
                    turnArrived.countDown()
                    check(releaseTurn.await(5, TimeUnit.SECONDS)) { "Send response was not released" }
                    MockResponse().setResponseCode(503).setBody("""{"error":{"code":"internal_error","message":"Try again","requestId":"request-draft","retryable":true}}""")
                }
                "/api/aiden/v1/chats/chat-draft/attachments" -> {
                    val name = json.parseToJsonElement(request.body.readUtf8()).jsonObject["name"]!!.jsonPrimitive.content
                    MockResponse().setResponseCode(201).setBody(json.encodeToString(AidenAttachmentReference(
                        id = "att_" + name.padEnd(43, 'x'), name = name, mimeType = "text/plain",
                        kind = AidenAttachmentKind.TEXT, size = 1, expiresAt = Instant.now().plusSeconds(600)
                    )))
                }
                "/api/aiden/v1/chats/chat-draft" -> MockResponse().setBody(json.encodeToString(initialChat))
                else -> MockResponse().setResponseCode(404)
            }
        }
        server.start()
        Dispatchers.setMain(dispatcher)
        try {
            runBlocking(dispatcher) {
                val installations = AidenInstallationStore(directory, InMemoryAidenSecureStore())
                val installation = installations.addInstallation(
                    AidenPairingExchange(
                        instanceId = "instance-draft", deviceId = "device-draft",
                        endpoint = server.url("/api/aiden/v1").toString(), serverSpkiSha256 = "sha256/test",
                        credential = "synthetic-credential",
                        capabilities = listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.CHAT_WRITE)
                    ), null
                )
                val drafts = AidenChatDraftStore(directory)
                val cache = AidenChatCache(directory)
                // Use the production client binding without unrelated /server refresh work.
                val coordinator = AidenRemoteCoordinator(
                    installations, directory, cache, drafts,
                    scope = CoroutineScope(dispatcher + Job().apply { cancel() })
                )
                coordinator.refreshClient()
                val model = AidenChatViewModel(initialChat.id, coordinator, cache, drafts, initialChat)
                viewModels.put("chat", model)
                yield()
                withTimeout(5_000) { model.isLoading.first { !it } }
                model.updateDraft("Original unsent text")
                assertTrue(model.canSend)
                if (checkPreparation) {
                    val mainThread = Thread.currentThread()
                    val entered = CountDownLatch(1)
                    val release = CountDownLatch(1)
                    val nextEntered = CountDownLatch(1)
                    val nextRelease = CountDownLatch(1)
                    val first = launch(start = CoroutineStart.UNDISPATCHED) {
                        model.prepareAndUpload(listOf(1, 2)) {
                            assertNotSame("Preparation must not run on Main", mainThread, Thread.currentThread())
                            entered.countDown()
                            check(release.await(5, TimeUnit.SECONDS))
                            null
                        }
                    }
                    val second = launch(start = CoroutineStart.UNDISPATCHED) {
                        model.prepareAndUpload(listOf(3)) {
                            nextEntered.countDown()
                            check(nextRelease.await(5, TimeUnit.SECONDS))
                            null
                        }
                    }
                    try {
                        withContext(Dispatchers.IO) { assertTrue(entered.await(5, TimeUnit.SECONDS)) }
                        assertEquals(2, model.preparingAttachmentBatches.value)
                        assertEquals(1L, nextEntered.count)
                        assertFalse(model.canSend)
                        model.send()
                        assertFalse(model.isStarting.value)
                        assertEquals("Original unsent text", model.draft.value)
                        first.cancel()
                        release.countDown()
                        first.join()
                        withContext(Dispatchers.IO) { assertTrue(nextEntered.await(5, TimeUnit.SECONDS)) }
                        assertEquals(1, model.preparingAttachmentBatches.value)
                        assertFalse(model.canSend)
                    } finally {
                        release.countDown()
                        nextRelease.countDown()
                        first.cancelAndJoin()
                        second.join()
                    }
                    val order = mutableListOf<Int>()
                    model.prepareAndUpload((1..10).toList()) {
                        order.add(it)
                        if (it == 4) error("Invalid provider selection")
                        AidenAttachmentUpload.Text(name = "selection-$it", mimeType = "text/plain", text = "x")
                    }
                    assertEquals((1..10).toList(), order)
                    assertEquals((1..10).filter { it != 4 }.map { "selection-$it" }, model.pendingAttachments.value.map { it.name })
                    assertEquals(0, model.preparingAttachmentBatches.value)
                    assertTrue(model.canSend)
                }
                model.send()
                withContext(Dispatchers.IO) { assertTrue(turnArrived.await(5, TimeUnit.SECONDS)) }
                assertTrue(model.isStarting.value)
                assertEquals("", model.draft.value)
                // Sending intentionally clears persistence until a response is known.
                assertNull(AidenChatDraftStore(directory).getDraft(installation.instanceId, initialChat.id))
                // A foreground reload during POST must not erase the local message.
                model.loadChat()
                yield()
                withTimeout(5_000) { model.isLoading.first { !it } }
                assertEquals("Original unsent text", model.chat.value!!.messages.single().text)
                if (newerText.isNotEmpty()) model.updateDraft(newerText)
                if (purgeWhileSending) coordinator.removeInstallation(installation.id)
                releaseTurn.countDown()
                withTimeout(5_000) { model.isStarting.first { !it } }
                val expected = if (newerText.isEmpty()) "Original unsent text" else "Original unsent text\n\n$newerText"
                assertEquals(expected, model.draft.value)
                assertNull(model.presentedError.value)
                if (!purgeWhileSending) assertNotNull(model.pendingSend.value)
                assertTrue(model.chat.value!!.messages.isEmpty())
                viewModels.clearAndJoin()
                // A fresh store is the process-restart read path, not the ViewModel's memory.
                val reopened = AidenChatDraftStore(directory)
                if (!purgeWhileSending && !checkPreparation && newerText.isEmpty()) {
                    val restored = AidenChatViewModel(initialChat.id, coordinator, cache, reopened, initialChat)
                    viewModels.put("restored", restored)
                    withTimeout(5_000) { restored.isLoading.first { !it } }
                    restored.updateDraft("Later edit")
                    restored.send()
                    assertEquals(1, sendKeys.size)
                    restored.send(retry = true)
                    withTimeout(5_000) { restored.isStarting.first { !it } }
                    assertEquals(2, sendKeys.size)
                    assertEquals(sendKeys[0], sendKeys[1])
                    assertTrue(restored.draft.value.contains("Later edit"))
                }
                if (purgeWhileSending || checkPreparation || newerText.isNotEmpty()) assertEquals(
                    if (purgeWhileSending) null else expected,
                    reopened.getDraft(installation.instanceId, initialChat.id)
                )
            }
        } finally {
            releaseTurn.countDown()
            runBlocking(dispatcher) { viewModels.clearAndJoin() }
            Dispatchers.resetMain()
            dispatcher.close()
            server.shutdown()
            directory.deleteRecursively()
        }
    }

    @Test
    fun approvalTapIsBoundToDisplayedIdAndDuplicateTapsDoNotSend() = exerciseRunControl("approval")

    @Test
    fun unknownApprovalOutcomeRefreshesWithoutResendingCapturedCard() = exerciseRunControl("unknown")

    @Test
    fun approvalCompletionAfterRevocationCannotRestoreCard() = exerciseRunControl("revoked")

    @Test
    fun unsupportedApprovalCapabilityPreventsResponse() = exerciseRunControl("unsupported")

    @Test
    fun botControlsRequireBotWriteGrant() = exerciseRunControl("bot-denied")

    @Test
    fun duplicateStopWaitsForAcknowledgementAndShowsFailure() = exerciseRunControl("stop")

    @Test
    fun lateStopAcknowledgementCannotUndoTerminalEvent() = exerciseRunControl("stop-terminal")

    @Test
    fun lateApprovalFailureCannotUndoTerminalEvent() = exerciseRunControl("approval-terminal")

    @Test
    fun fallbackDoesNotCoalesceWithPreResponseSnapshot() = exerciseRunControl("approval-fallback-before")

    @Test
    fun ambiguousResponseCannotSupersedeHeldAuthoritativeApproval() = exerciseRunControl("approval-fallback-overlap")

    @Test
    fun latestAdmittedApprovalReadWinsWhenOlderCompletesFirst() = exerciseRunControl("approval-overlap")

    @Test
    fun mismatchedStopAcknowledgementShowsFailure() = exerciseRunControl("stop-mismatch")

    @Test
    fun lateStopAcknowledgementAfterUnpairCannotControlOrReport() = exerciseRunControl("stop-revoked")

    @Test
    fun droppedStopRequestIsNotRetriedAndLeavesRunControllable() = exerciseRunControl("stop-disconnect")

    @Test
    fun approvalSnapshotHeldAcrossUnpairCannotRestoreCard() = exerciseRunControl("approval-snapshot-revoked")

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun approvalResolvedOnMacHandsTheWaitToTheSurvivingQuestion() {
        val directory = kotlin.io.path.createTempDirectory("aiden-question-handoff-").toFile()
        val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val approvalResolved = java.util.concurrent.atomic.AtomicBoolean(false)
        val eventConnections = java.util.concurrent.atomic.AtomicInteger()
        val resolve = CountDownLatch(1)
        val eventsOpened = CountDownLatch(1)
        val server = MockWebServer()
        val viewModels = ViewModelStore()
        val grants = listOf(
            AidenRemoteCapability.SERVER_READ, AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.CHAT_WRITE,
            AidenRemoteCapability.APPROVAL_RESPOND, AidenRemoteCapability.QUESTIONS_RESPOND
        )
        val chat = AidenChat(id = "chat-control", workspaceId = "workspace-control", title = "Controls",
            messages = emptyList(), createdAt = Instant.EPOCH, updatedAt = Instant.EPOCH, revision = "revision-control")
        val questions = """[{"question":"Which branch?","header":"Branch","multiSelect":false,"options":[{"label":"main","description":"Default"},{"label":"dev","description":"Work"}]}]"""
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                return when {
                    path == "/api/aiden/v1/server" -> MockResponse().setBody("""{"protocolVersion":1,"instanceId":"instance-control","name":"Control Mac","appVersion":"1.0","capabilities":${json.encodeToString(grants)},"serverCapabilities":${json.encodeToString(grants)},"features":["chat-question-prompts-v1"],"connectionMode":"lan","serverTime":"2026-09-22T12:00:00Z"}""")
                    path == "/api/aiden/v1/workspaces" -> MockResponse().setBody("""{"workspaces":[]}""")
                    path == "/api/aiden/v1/chats/chat-control" -> MockResponse().setBody(json.encodeToString(chat))
                    path.startsWith("/api/aiden/v1/streams/stream-control/events") -> {
                        // The first connection ends so the status read restores
                        // both prompts. On the next live connection the Mac
                        // resolves the approval itself and journals only the
                        // surviving question: no running status, no reconnect.
                        val connection = eventConnections.incrementAndGet()
                        if (connection == 1) {
                            return MockResponse().setHeader("Content-Type", "text/event-stream").setBody("")
                        }
                        val first = connection == 2
                        if (first) {
                            eventsOpened.countDown()
                            check(resolve.await(10, TimeUnit.SECONDS))
                        }
                        val event = if (first) {
                            "id: 1\nevent: question_required\ndata: {\"protocolVersion\":1,\"streamId\":\"stream-control\",\"sequence\":1,\"timestamp\":\"2026-09-22T12:00:00Z\",\"type\":\"question_required\",\"terminal\":false,\"payload\":{\"promptId\":\"question-current\",\"questions\":$questions,\"expiresAt\":\"2099-01-01T00:00:00Z\"}}\n\n"
                        } else ": keepalive\n\n"
                        // Throttled padding holds the stream open for the test
                        // without blocking shutdown once the client disconnects.
                        val chunk = maxOf(event.toByteArray().size, 256)
                        MockResponse().setHeader("Content-Type", "text/event-stream")
                            .setBody(event + ": open\n\n".repeat(chunk * 20 / 8))
                            .throttleBody(chunk.toLong(), 500, TimeUnit.MILLISECONDS)
                    }
                    path == "/api/aiden/v1/streams/stream-control" -> MockResponse().setBody("""{"streamId":"stream-control","chatId":"chat-control","turnId":"turn-control","state":"waiting_for_approval","lastSequence":0,"updatedAt":"2026-09-22T12:00:00Z"}""")
                    path == "/api/aiden/v1/streams/stream-control/approval" -> MockResponse().setBody(
                        if (approvalResolved.get()) """{"approval":null}"""
                        else """{"approval":{"approvalId":"approval-current","streamId":"stream-control","chatId":"chat-control","summary":"Review current action","toolCallId":"tool-control","toolName":"read_file","expiresAt":"2099-01-01T00:00:00Z","canAllow":true}}"""
                    )
                    path == "/api/aiden/v1/streams/stream-control/question" -> MockResponse().setBody(
                        """{"question":{"promptId":"question-current","streamId":"stream-control","chatId":"chat-control","toolCallId":"tool-question","questions":$questions,"expiresAt":"2099-01-01T00:00:00Z"}}"""
                    )
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        Dispatchers.setMain(dispatcher)
        val scopeJob = Job()
        try {
            runBlocking(dispatcher) {
                val installations = AidenInstallationStore(directory, InMemoryAidenSecureStore())
                installations.addInstallation(AidenPairingExchange(
                    instanceId = "instance-control", deviceId = "device-control", endpoint = server.url("/api/aiden/v1").toString(),
                    serverSpkiSha256 = "sha256/test", credential = "synthetic-credential", capabilities = grants), null)
                val cache = AidenChatCache(directory)
                val drafts = AidenChatDraftStore(directory)
                val coordinator = AidenRemoteCoordinator(installations, directory, cache, drafts, scope = CoroutineScope(dispatcher + scopeJob))
                coordinator.refreshClient()
                withTimeout(5_000) { coordinator.serverInfo.first { it != null } }
                cache.saveActiveStream(AidenChatCache.ActiveStream("device-control", "stream-control", "turn-control", 0), "instance-control", chat.id)
                val model = AidenChatViewModel(chat.id, coordinator, cache, drafts, chat)
                viewModels.put("control", model)
                // Both prompts pending: the approval gates the tool and wins.
                withTimeout(5_000) { model.pendingApproval.first { it?.id == "approval-current" } }
                withTimeout(5_000) { model.pendingQuestion.first { it?.id == "question-current" } }

                withContext(Dispatchers.IO) { assertTrue(eventsOpened.await(5, TimeUnit.SECONDS)) }
                approvalResolved.set(true)
                resolve.countDown()
                withTimeout(5_000) { model.pendingApproval.first { it == null } }
                assertEquals("question-current", model.pendingQuestion.value?.id)
                assertEquals(AidenStreamState.WAITING_FOR_APPROVAL, model.streamState.value)
            }
        } finally {
            resolve.countDown()
            runBlocking(dispatcher) { viewModels.clearAndJoin(); scopeJob.cancelAndJoin() }
            Dispatchers.resetMain()
            dispatcher.close()
            server.shutdown()
            directory.deleteRecursively()
        }
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private fun exerciseRunControl(scenario: String) {
        val directory = kotlin.io.path.createTempDirectory("aiden-control-").toFile()
        val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val arrived = CountDownLatch(1)
        val release = CountDownLatch(1)
        val finishRead = CountDownLatch(1)
        val terminal = java.util.concurrent.atomic.AtomicBoolean(false)
        val writes = java.util.concurrent.atomic.AtomicInteger()
        val failApprovalReads = java.util.concurrent.atomic.AtomicBoolean(false)
        val snapshotId = java.util.concurrent.atomic.AtomicReference("approval-current")
        val oldRead = CountDownLatch(1)
        val newRead = CountDownLatch(1)
        val releaseOld = CountDownLatch(1)
        val releaseNew = CountDownLatch(1)
        val server = MockWebServer()
        val viewModels = ViewModelStore()
        val grants = listOf(AidenRemoteCapability.SERVER_READ, AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.CHAT_WRITE) +
            if (scenario == "unsupported") emptyList() else listOf(AidenRemoteCapability.APPROVAL_RESPOND)
        val chat = AidenChat(id = "chat-control", workspaceId = "workspace-control", title = "Controls",
            botId = if (scenario == "bot-denied") "bot-control" else null, messages = emptyList(), createdAt = Instant.EPOCH, updatedAt = Instant.EPOCH, revision = "revision-control")
        val status = """{"streamId":"stream-control","chatId":"chat-control","turnId":"turn-control","state":"waiting_for_approval","lastSequence":0,"updatedAt":"2026-09-22T12:00:00Z"}"""
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path == "/api/aiden/v1/server" -> MockResponse().setBody("""{"protocolVersion":1,"instanceId":"instance-control","name":"Control Mac","appVersion":"1.0","capabilities":${json.encodeToString(grants)},"serverCapabilities":${json.encodeToString(grants)},"features":[],"connectionMode":"lan","serverTime":"2026-09-22T12:00:00Z"}""")
                request.path == "/api/aiden/v1/workspaces" -> MockResponse().setBody("""{"workspaces":[]}""")
                request.path == "/api/aiden/v1/chats/chat-control" -> {
                    if (terminal.get()) check(finishRead.await(10, TimeUnit.SECONDS))
                    MockResponse().setBody(json.encodeToString(chat))
                }
                request.path == "/api/aiden/v1/streams/stream-control/events" -> MockResponse().setHeader("Content-Type", "text/event-stream").setBody(if (terminal.get()) "id: 1\nevent: done\ndata: {\"protocolVersion\":1,\"streamId\":\"stream-control\",\"sequence\":1,\"timestamp\":\"2026-09-22T12:00:00Z\",\"type\":\"done\",\"terminal\":true,\"payload\":{\"messageId\":\"message-control\"}}\n\n" else "")
                request.path == "/api/aiden/v1/streams/stream-control" -> MockResponse().setBody(status)
                request.path == "/api/aiden/v1/streams/stream-control/approval" -> {
                    if (failApprovalReads.get()) return MockResponse().setResponseCode(503)
                    val id = snapshotId.get()
                    if ((scenario in listOf("approval-overlap", "approval-fallback-overlap", "approval-snapshot-revoked") && id != "approval-current") ||
                        (scenario == "approval-fallback-before" && id == "approval-old")) {
                        (if (id == "approval-old") oldRead else newRead).countDown()
                        check((if (id == "approval-old") releaseOld else releaseNew).await(10, TimeUnit.SECONDS))
                    }
                    MockResponse().setBody("""{"approval":{"approvalId":"${id}","streamId":"stream-control","chatId":"chat-control","summary":"Review current action","toolCallId":"tool-control","toolName":"read_file","expiresAt":"2099-01-01T00:00:00Z","canAllow":true}}""")
                }
                request.method == "POST" -> {
                    writes.incrementAndGet()
                    arrived.countDown()
                    check(release.await(10, TimeUnit.SECONDS))
                    if (scenario == "stop-disconnect") {
                        return MockResponse().setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.DISCONNECT_AFTER_REQUEST)
                    }
                    if (scenario.startsWith("stop-")) {
                        val responseStatus = if (scenario == "stop-mismatch") status.replace("stream-control", "stream-other") else status.replace("waiting_for_approval", "reconciling")
                        return MockResponse().setResponseCode(202).setBody(responseStatus)
                    }
                    if (scenario == "unknown") {
                        snapshotId.set("approval-next")
                        return MockResponse().setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.DISCONNECT_AFTER_REQUEST)
                    }
                    MockResponse().setResponseCode(503).setBody("""{"error":{"code":"internal_error","message":"Unconfirmed","requestId":"request-control","retryable":true}}""")
                }
                else -> MockResponse().setResponseCode(404)
            }
        }
        server.start()
        Dispatchers.setMain(dispatcher)
        val scopeJob = Job()
        try {
            runBlocking(dispatcher) {
                val installations = AidenInstallationStore(directory, InMemoryAidenSecureStore())
                val installation = installations.addInstallation(AidenPairingExchange(
                    instanceId = "instance-control", deviceId = "device-control", endpoint = server.url("/api/aiden/v1").toString(),
                    serverSpkiSha256 = "sha256/test", credential = "synthetic-credential", capabilities = grants), null)
                val cache = AidenChatCache(directory)
                val drafts = AidenChatDraftStore(directory)
                val coordinator = AidenRemoteCoordinator(installations, directory, cache, drafts, scope = CoroutineScope(dispatcher + scopeJob))
                coordinator.refreshClient()
                withTimeout(5_000) { coordinator.serverInfo.first { it != null } }
                cache.saveActiveStream(AidenChatCache.ActiveStream("device-control", "stream-control", "turn-control", 0), "instance-control", chat.id)
                val model = AidenChatViewModel(chat.id, coordinator, cache, drafts, chat)
                viewModels.put("control", model)
                withTimeout(5_000) { model.pendingApproval.first { it?.id == "approval-current" } }
                if (scenario == "approval-fallback-before") {
                    snapshotId.set("approval-old")
                    val read = async { model.restorePendingApproval("stream-control") }
                    withContext(Dispatchers.IO) { assertTrue(oldRead.await(5, TimeUnit.SECONDS)) }
                    snapshotId.set("approval-new")
                    release.countDown()
                    model.respondToApproval(AidenApprovalDecision.ALLOW, "approval-current")
                    withTimeout(5_000) { model.isRespondingToApproval.first { !it } }
                    assertEquals("approval-new", model.pendingApproval.value?.id)
                    releaseOld.countDown()
                    read.await()
                    assertEquals("approval-new", model.pendingApproval.value?.id)
                    return@runBlocking
                }
                if (scenario == "approval-fallback-overlap") {
                    model.respondToApproval(AidenApprovalDecision.ALLOW, "approval-current")
                    withContext(Dispatchers.IO) { assertTrue(arrived.await(5, TimeUnit.SECONDS)) }
                    snapshotId.set("approval-new")
                    val read = async { model.restorePendingApproval("stream-control") }
                    withContext(Dispatchers.IO) { assertTrue(newRead.await(5, TimeUnit.SECONDS)) }
                    failApprovalReads.set(true)
                    release.countDown()
                    withTimeout(5_000) { model.isRespondingToApproval.first { !it } }
                    releaseNew.countDown()
                    read.await()
                    assertEquals("approval-new", model.pendingApproval.value?.id)
                    assertEquals(AidenStreamState.WAITING_FOR_APPROVAL, model.streamState.value)
                    return@runBlocking
                }
                if (scenario == "approval-snapshot-revoked") {
                    // A snapshot read that was admitted before unpair must not paint a card
                    // for an installation whose credentials are gone.
                    snapshotId.set("approval-old")
                    val read = async { model.restorePendingApproval("stream-control") }
                    withContext(Dispatchers.IO) { assertTrue(oldRead.await(5, TimeUnit.SECONDS)) }
                    coordinator.removeInstallation(installation.id)
                    releaseOld.countDown()
                    read.await()
                    assertNotEquals("approval-old", model.pendingApproval.value?.id)
                    assertFalse(model.canControlCurrentRun)
                    model.respondToApproval(AidenApprovalDecision.ALLOW, "approval-old")
                    model.stop()
                    assertEquals(0, writes.get())
                    return@runBlocking
                }
                if (scenario == "approval-overlap") {
                    snapshotId.set("approval-old")
                    val old = async { model.restorePendingApproval("stream-control") }
                    withContext(Dispatchers.IO) { assertTrue(oldRead.await(5, TimeUnit.SECONDS)) }
                    snapshotId.set("approval-new")
                    val newer = async { model.restorePendingApproval("stream-control") }
                    withContext(Dispatchers.IO) { assertTrue(newRead.await(5, TimeUnit.SECONDS)) }
                    model.restorePendingApproval("stale-stream")
                    releaseOld.countDown()
                    old.await()
                    releaseNew.countDown()
                    newer.await()
                    assertEquals("approval-new", model.pendingApproval.value?.id)
                    return@runBlocking
                }
                model.respondToApproval(AidenApprovalDecision.ALLOW, "approval-stale")
                assertEquals(0, writes.get())
                if (scenario == "unsupported" || scenario == "bot-denied") {
                    if (scenario == "bot-denied") {
                        assertFalse(model.canControlCurrentRun)
                        model.stop()
                    }
                    model.respondToApproval(AidenApprovalDecision.ALLOW, "approval-current")
                    withTimeout(5_000) { model.isRespondingToApproval.first { !it } }
                    assertEquals(0, writes.get())
                    assertNotNull(model.pendingApproval.value)
                    assertFalse(model.pendingApproval.value!!.canRespond)
                    return@runBlocking
                }
                if (scenario.startsWith("stop")) {
                    assertTrue(model.canControlCurrentRun)
                    model.stop()
                    model.stop()
                    assertTrue(model.isStopping.value)
                    assertEquals(AidenStreamState.WAITING_FOR_APPROVAL, model.streamState.value)
                } else {
                    model.respondToApproval(AidenApprovalDecision.ALLOW, "approval-current")
                    model.respondToApproval(AidenApprovalDecision.DENY, "approval-current")
                    assertTrue(model.isRespondingToApproval.value)
                }
                withContext(Dispatchers.IO) { assertTrue(arrived.await(5, TimeUnit.SECONDS)) }
                assertEquals(1, writes.get())
                if (scenario == "revoked" || scenario == "stop-revoked") coordinator.removeInstallation(installation.id)
                if (scenario.endsWith("terminal")) {
                    terminal.set(true)
                    withTimeout(5_000) { model.streamState.first { it?.isTerminal == true } }
                }
                release.countDown()
                if (scenario.startsWith("stop")) {
                    withTimeout(5_000) { model.isStopping.first { !it } }
                    if (scenario.endsWith("terminal")) assertTrue(model.streamState.value!!.isTerminal)
                    else if (scenario == "stop-revoked") {
                        // The late 202 belongs to a revoked client: no reconcile, no error, no controls.
                        assertNotEquals(AidenStreamState.RECONCILING, model.streamState.value)
                        assertNull(model.presentedError.value)
                        assertFalse(model.canControlCurrentRun)
                        model.stop()
                        assertFalse(model.isStopping.value)
                    } else {
                        assertTrue(model.presentedError.value!!.contains("Stop was not confirmed"))
                        assertFalse(model.streamState.value!!.isTerminal)
                        if (scenario == "stop-disconnect") {
                            // No optimistic cancel: the run stays live and the user may retry.
                            assertEquals(AidenStreamState.WAITING_FOR_APPROVAL, model.streamState.value)
                            assertEquals("approval-current", model.pendingApproval.value?.id)
                            assertTrue(model.canControlCurrentRun)
                        }
                    }
                } else {
                    withTimeout(5_000) { model.isRespondingToApproval.first { !it } }
                    if (scenario.endsWith("terminal")) {
                        assertTrue(model.streamState.value!!.isTerminal)
                        assertNull(model.pendingApproval.value)
                    } else if (scenario == "revoked") {
                        assertNull(model.pendingApproval.value)
                        assertFalse(model.canControlCurrentRun)
                        model.respondToApproval(AidenApprovalDecision.ALLOW, "approval-current")
                    } else {
                        assertEquals(if (scenario == "unknown") "approval-next" else "approval-current", model.pendingApproval.value?.id)
                    }
                }
                assertEquals(1, writes.get())
            }
        } finally {
            releaseOld.countDown()
            releaseNew.countDown()
            release.countDown()
            finishRead.countDown()
            runBlocking(dispatcher) { viewModels.clearAndJoin(); scopeJob.cancelAndJoin() }
            Dispatchers.resetMain()
            dispatcher.close()
            server.shutdown()
            directory.deleteRecursively()
        }
    }

    @Test
    fun testCustomModelOverridesPreserveImageAndVisibilityFlags() {
        val catalog = json.decodeFromString<AidenModelCatalog>("""
            {"providers":[{"id":"custom:tailnet","label":"Private","models":[{"id":"text","label":"Text","supportsImages":false},{"id":"vision","label":"Vision","supportsImages":true,"hidden":true}]}],"defaults":{}}
        """.trimIndent())
        assertFalse(catalog.providers.first().models.first().acceptsImageInput)
        assertTrue(catalog.providers.first().models.last().acceptsImageInput)
        assertEquals(listOf("text"), catalog.visibleProviders.first().models.map { it.id })
    }

    @Test
    fun testHiddenAndAllHiddenProviderModelsStayOutOfNewSelections() {
        val wire = """
            {
              "providers":[
                {"id":"google","label":"Google","models":[
                  {"id":"gemini-pro","label":"Gemini Pro","hidden":true},
                  {"id":"gemini-flash","label":"Gemini Flash"}
                ]},
                {"id":"all-hidden","label":"Hidden","models":[
                  {"id":"legacy","label":"Legacy","hidden":true}
                ]}
              ],
              "defaults":{"providerId":"google","modelId":"gemini-flash"}
            }
        """.trimIndent()

        val catalog = json.decodeFromString<AidenModelCatalog>(wire)

        assertEquals(listOf("gemini-pro", "gemini-flash"), catalog.providers.first().models.map { it.id })
        assertEquals(listOf("google"), catalog.visibleProviders.map { it.id })
        assertEquals(listOf("gemini-flash"), catalog.visibleProviders.first().models.map { it.id })
    }

    @Test
    fun testParentVisibleMessageTextPreservesExactSemanticContent() {
        val samples = listOf(
            "NFC café | NFD cafe\u0301 | हिन्दी | 日本語 | العربية",
            "Emoji 👩🏽‍💻 👨‍👩‍👧‍👦 🇺🇳 1️⃣ 🚀",
            "/Users/example/Aiden Projects/π.kt | C:\\Users\\example\\Aiden Projects\\pi.kt",
            "/api/aiden/v1/chats/chat_01?after=42 | https://example.test/a%2Fb?q=hello%20world#résumé",
            "UUID 123e4567-e89b-12d3-a456-426614174000 | base64 SGVsbG8sIFdvcmxkIQ== | hex deadbeef0123456789ABCDEF",
            "Benign prose: token=session_token, secret=example-secret, api_key=example_api_key, Authorization: Bearer visible-placeholder"
        )

        samples.forEachIndexed { index, expected ->
            val wire = buildJsonObject {
                put("id", "message-$index")
                put("role", "assistant")
                put("text", expected)
                put("createdAt", "2026-08-25T18:00:00.000Z")
            }
            val decoded = json.decodeFromString<AidenChatMessage>(wire.toString())
            assertArrayEquals("UTF-8 changed for sample $index", expected.toByteArray(), decoded.text.toByteArray())
            assertArrayEquals("Unicode scalars changed for sample $index", expected.codePoints().toArray(), decoded.text.codePoints().toArray())

            val projected = json.parseToJsonElement(json.encodeToString(decoded)).jsonObject
            val projectedText = projected.getValue("text").jsonPrimitive.content
            assertArrayEquals("Encoded UTF-8 changed for sample $index", expected.toByteArray(), projectedText.toByteArray())
            assertArrayEquals("Encoded Unicode scalars changed for sample $index", expected.codePoints().toArray(), projectedText.codePoints().toArray())
        }
    }

    @Test
    fun testUnknownChildFieldsAreDroppedAndPublicModelsCannotSerializeChildState() {
        val wire = """
            {
              "id":"message-parent",
              "role":"assistant",
              "text":"Parent-visible result and report back",
              "createdAt":"2026-08-25T18:00:00.000Z",
              "subagents":{"version":2,"runIds":["run-private"]},
              "childRunId":"run-private",
              "childTranscript":[{"role":"assistant","text":"private child text"}],
              "childResult":"private child result"
            }
        """.trimIndent()

        val decoded = json.decodeFromString<AidenChatMessage>(wire)
        val encodedMessage = json.parseToJsonElement(json.encodeToString(decoded)).jsonObject
        val catalog = AidenModelCatalog(
            providers = listOf(
                AidenProvider(
                    id = "provider-public",
                    label = "Public provider",
                    models = listOf(AidenModel(id = "model-public", label = "Public model"))
                )
            ),
            defaults = mapOf("providerId" to "provider-public", "modelId" to "model-public")
        )
        val encodedCatalog = json.parseToJsonElement(json.encodeToString(catalog)).jsonObject
        val childKeys = setOf("subagents", "childId", "childRunId", "childTranscript", "childResult", "task", "result", "privateHistory")

        assertEquals("Parent-visible result and report back", encodedMessage.getValue("text").jsonPrimitive.content)
        assertTrue(childKeys.intersect(encodedMessage.keys).isEmpty())
        assertTrue(childKeys.none { encodedMessage.toString().contains("\"$it\"") })
        assertTrue(childKeys.none { encodedCatalog.toString().contains("\"$it\"") })
    }

    @Test
    fun testHtmlArtifactsDecodeWithoutInlineHtml() {
        val wire = """
            {
              "id":"message-html",
              "role":"assistant",
              "text":"Chart.",
              "createdAt":"2026-08-25T18:00:00.000Z",
              "htmlArtifacts":[{"id":"html-1","title":"Dependencies"}]
            }
        """.trimIndent()
        val decoded = json.decodeFromString<AidenChatMessage>(wire)
        assertEquals("html-1", decoded.htmlArtifacts?.first()?.id)
        assertEquals("Dependencies", decoded.htmlArtifacts?.first()?.title)
        assertTrue(decoded.htmlArtifacts?.first()?.isWireSafe == true)
        assertTrue(decoded.isWireSafe)
        val encoded = json.parseToJsonElement(json.encodeToString(decoded)).jsonObject
        assertFalse(encoded.toString().contains("<script"))
    }

    @Test
    fun testPolymorphicAttachmentUploads() {
        val imageUpload: AidenAttachmentUpload = AidenAttachmentUpload.Image(
            name = "photo.png",
            mimeType = "image/png",
            data = "AQID"
        )
        val imageJson = json.encodeToString(imageUpload)
        assertTrue(imageJson.contains("\"kind\":\"image\""))
        assertTrue(imageJson.contains("\"name\":\"photo.png\""))
        assertTrue(imageJson.contains("\"data\":\"AQID\""))

        val textUpload: AidenAttachmentUpload = AidenAttachmentUpload.Text(
            name = "notes.txt",
            mimeType = "text/plain",
            text = "Hello world"
        )
        val textJson = json.encodeToString(textUpload)
        assertTrue(textJson.contains("\"kind\":\"text\""))
        assertTrue(textJson.contains("\"name\":\"notes.txt\""))
        assertTrue(textJson.contains("\"text\":\"Hello world\""))

        val decodedImage = json.decodeFromString<AidenAttachmentUpload>(imageJson)
        assertTrue(decodedImage is AidenAttachmentUpload.Image)
        assertEquals("photo.png", decodedImage.name)

        val decodedText = json.decodeFromString<AidenAttachmentUpload>(textJson)
        assertTrue(decodedText is AidenAttachmentUpload.Text)
        assertEquals("Hello world", (decodedText as AidenAttachmentUpload.Text).text)
    }

    @Test
    fun testAttachmentWireValidation() {
        val validAttachment = AidenMessageAttachment(
            id = "att_valid_123",
            name = "diagram.png",
            mimeType = "image/png",
            kind = AidenAttachmentKind.IMAGE,
            size = 1024
        )
        assertTrue(validAttachment.isWireSafe)

        val invalidPathName = AidenMessageAttachment(
            id = "att_valid_123",
            name = "../etc/passwd",
            mimeType = "text/plain",
            kind = AidenAttachmentKind.TEXT,
            size = 1024
        )
        assertFalse(invalidPathName.isWireSafe)

        val emptyName = AidenMessageAttachment(
            id = "att_1",
            name = "",
            mimeType = "text/plain",
            kind = AidenAttachmentKind.TEXT,
            size = 100
        )
        assertFalse(emptyName.isWireSafe)

        val negativeSize = AidenMessageAttachment(
            id = "att_1",
            name = "valid.txt",
            mimeType = "text/plain",
            kind = AidenAttachmentKind.TEXT,
            size = -1
        )
        assertFalse(negativeSize.isWireSafe)
    }

    @Test
    fun testTimelineRendererSafetyWithLineChangesAndClaimCheck() {
        val validTimeline = AidenGenerationTimeline(
            version = 3,
            generationId = "gen_123",
            status = AidenGenerationTimelineStatus.COMPLETED,
            startedAt = 1000.0,
            finishedAt = 2000.0,
            steps = listOf(
                AidenAgentStep(
                    id = "tool-1",
                    order = 0,
                    kind = AidenAgentStep.Kind.TOOL,
                    toolCallId = "call-1",
                    toolName = "write_file",
                    label = "Write file",
                    status = AidenAgentStepStatus.COMPLETED,
                    startedAt = 1000.0,
                    updatedAt = 1500.0,
                    finishedAt = 1500.0,
                    contentOffset = 0,
                    target = "README.md",
                    lineChanges = AidenAgentLineChanges(additions = 10, deletions = 2)
                )
            )
        )
        assertTrue(validTimeline.isRendererSafe())

        // Line changes on non-completed status must fail
        val nonCompletedLineChanges = validTimeline.copy(
            steps = listOf(
                validTimeline.steps[0].copy(status = AidenAgentStepStatus.RUNNING)
            )
        )
        assertFalse(nonCompletedLineChanges.isRendererSafe())

        // Line changes out of 0..100M bound must fail
        val negativeLineChanges = validTimeline.copy(
            steps = listOf(
                validTimeline.steps[0].copy(lineChanges = AidenAgentLineChanges(-1, 0))
            )
        )
        assertFalse(negativeLineChanges.isRendererSafe())

        // Claim check with running status must fail
        val runningWithClaimCheck = validTimeline.copy(
            status = AidenGenerationTimelineStatus.RUNNING,
            claimCheck = AidenGenerationClaimCheck(
                kind = AidenGenerationClaimCheck.Kind.UNVERIFIED_SUCCESS,
                stepIds = listOf("tool-1")
            )
        )
        assertFalse(runningWithClaimCheck.isRendererSafe())

        // Claim check pointing to non-issue step must fail
        val completedWithInvalidClaimCheck = validTimeline.copy(
            status = AidenGenerationTimelineStatus.COMPLETED,
            claimCheck = AidenGenerationClaimCheck(
                kind = AidenGenerationClaimCheck.Kind.UNVERIFIED_SUCCESS,
                stepIds = listOf("tool-1")
            )
        )
        assertFalse(completedWithInvalidClaimCheck.isRendererSafe())

        // Claim check pointing to actual failed/issue tool step succeeds
        val failedStepTimeline = AidenGenerationTimeline(
            version = 3,
            generationId = "gen_failed",
            status = AidenGenerationTimelineStatus.FAILED,
            startedAt = 1000.0,
            finishedAt = 2000.0,
            steps = listOf(
                AidenAgentStep(
                    id = "tool-1",
                    order = 0,
                    kind = AidenAgentStep.Kind.TOOL,
                    toolCallId = "call-1",
                    toolName = "run_command",
                    label = "Run command",
                    status = AidenAgentStepStatus.FAILED,
                    startedAt = 1000.0,
                    updatedAt = 1500.0,
                    finishedAt = 1500.0,
                    contentOffset = 0
                )
            ),
            claimCheck = AidenGenerationClaimCheck(
                kind = AidenGenerationClaimCheck.Kind.UNVERIFIED_SUCCESS,
                stepIds = listOf("tool-1")
            )
        )
        assertTrue(failedStepTimeline.isRendererSafe())
    }

    @Test
    fun testTimelineRejectsUnsafeTargets() {
        val baseStep = AidenAgentStep(
            id = "tool-1",
            order = 0,
            kind = AidenAgentStep.Kind.TOOL,
            toolCallId = "call-1",
            toolName = "read_file",
            label = "Read file",
            status = AidenAgentStepStatus.RUNNING,
            startedAt = 1000.0,
            updatedAt = 1000.0,
            contentOffset = 0,
            target = "/Users/private/secret"
        )
        val timeline = AidenGenerationTimeline(
            version = 3,
            generationId = "gen_test",
            status = AidenGenerationTimelineStatus.RUNNING,
            startedAt = 1000.0,
            steps = listOf(baseStep)
        )
        assertFalse(timeline.isRendererSafe())

        val windowsPath = timeline.copy(steps = listOf(baseStep.copy(target = """C:\Users\private\secret""")))
        assertFalse(windowsPath.isRendererSafe())

        val traversalPath = timeline.copy(steps = listOf(baseStep.copy(target = """folder\..\secret""")))
        assertFalse(traversalPath.isRendererSafe())
    }

    @Test
    fun formFillActivityDecodesCountOnlyOutcome() {
        val step = json.decodeFromString<AidenAgentStep>("""{"id":"tool-1","order":0,"kind":"tool","toolCallId":"call-1","toolName":"form_fill","label":"Form fill","status":"completed","startedAt":1000,"updatedAt":2000,"finishedAt":2000,"contentOffset":0,"detail":"1 filled · 1 not attempted · stopped early"}""")
        assertEquals("Form fill 1 filled · 1 not attempted · stopped early", AidenAgentActivityPresentation.line(step))
    }

    @Test
    fun testAgentRunActivityMatchesMacPresentationLanguage() {
        // Persisted labels as Google Antigravity steps record them; the Mac and
        // iOS presentation tests expect the same lines.
        data class Case(
            val toolName: String,
            val label: String,
            val status: AidenAgentStepStatus,
            val target: String?,
            val detail: String?,
            val line: String
        )
        val expected = listOf(
            Case("delete_file", "Delete file", AidenAgentStepStatus.RUNNING, "old.ts", null, "Deleting old.ts"),
            Case("delete_file", "Delete file", AidenAgentStepStatus.COMPLETED, "old.ts", null, "Deleted old.ts"),
            Case("move_file", "Move file", AidenAgentStepStatus.COMPLETED, "src/a.ts", null, "Moved src/a.ts"),
            Case("web_fetch", "Fetch web page", AidenAgentStepStatus.COMPLETED, null, null, "Fetched web page"),
            Case("agent_subagents", "Run subagents", AidenAgentStepStatus.COMPLETED, null, null, "Ran subagents"),
            Case("agent_tool", "Use agent tool", AidenAgentStepStatus.RUNNING, null, null, "Using an agent tool"),
            Case("agent_context_rebuilt", "Started a fresh agent session from this chat", AidenAgentStepStatus.COMPLETED, null, null, "Started a fresh agent session"),
            Case("run_command", "Run command", AidenAgentStepStatus.COMPLETED, null, "a command", "Ran a command"),
            Case("run_command", "Run command", AidenAgentStepStatus.FAILED, null, "a command", "Run command failed a command")
        )
        expected.forEachIndexed { index, case ->
            val step = AidenAgentStep(
                id = "tool-$index",
                order = index,
                kind = AidenAgentStep.Kind.TOOL,
                toolCallId = "call-$index",
                toolName = case.toolName,
                label = case.label,
                status = case.status,
                startedAt = 1000.0,
                updatedAt = 2000.0,
                finishedAt = if (case.status == AidenAgentStepStatus.COMPLETED) 2000.0 else null,
                contentOffset = 0,
                target = case.target,
                detail = case.detail
            )
            assertEquals(case.toolName, case.line, AidenAgentActivityPresentation.line(step))
        }
    }

    @Test
    fun testAgentActivityPresentation() {
        val readStep = AidenAgentStep(
            id = "tool-1",
            order = 0,
            kind = AidenAgentStep.Kind.TOOL,
            toolCallId = "call-1",
            toolName = "read_file",
            label = "Read file",
            status = AidenAgentStepStatus.COMPLETED,
            startedAt = 1000.0,
            updatedAt = 1500.0,
            finishedAt = 1500.0,
            contentOffset = 0,
            target = "README.md"
        )
        assertEquals("Read README.md", AidenAgentActivityPresentation.line(readStep))

        val thinkStep = AidenAgentStep(
            id = "think-1",
            order = 1,
            kind = AidenAgentStep.Kind.THINKING,
            status = AidenAgentStepStatus.COMPLETED,
            startedAt = 1500.0,
            updatedAt = 2500.0,
            finishedAt = 2500.0,
            contentOffset = 0,
            durationMs = 1000.0
        )
        assertEquals("Thought briefly", AidenAgentActivityPresentation.line(thinkStep))

        val runStep = AidenAgentStep(
            id = "tool-2",
            order = 2,
            kind = AidenAgentStep.Kind.TOOL,
            toolCallId = "call-2",
            toolName = "run_command",
            label = "Run command",
            status = AidenAgentStepStatus.COMPLETED,
            startedAt = 2500.0,
            updatedAt = 3000.0,
            finishedAt = 3000.0,
            contentOffset = 0,
            detail = "Run tests"
        )
        assertEquals("Ran Run tests", AidenAgentActivityPresentation.line(runStep))

        val timeline = AidenGenerationTimeline(
            version = 3,
            generationId = "gen_summary",
            status = AidenGenerationTimelineStatus.COMPLETED,
            startedAt = 1000.0,
            finishedAt = 3000.0,
            steps = listOf(readStep, thinkStep, runStep)
        )
        assertEquals("Explored 1 file, ran 1 command", AidenAgentActivityPresentation.summary(timeline))

        // Multiple categories summary
        val multiTimeline = AidenGenerationTimeline(
            version = 3,
            generationId = "gen_multi",
            status = AidenGenerationTimelineStatus.COMPLETED,
            startedAt = 1000.0,
            finishedAt = 2000.0,
            steps = listOf("web_search", "computer_use", "compact_context", "custom_tool").mapIndexed { index, name ->
                AidenAgentStep(
                    id = "tool-$index",
                    order = index,
                    kind = AidenAgentStep.Kind.TOOL,
                    toolCallId = "call-$index",
                    toolName = name,
                    label = "Tool",
                    status = AidenAgentStepStatus.COMPLETED,
                    startedAt = 1000.0,
                    updatedAt = 2000.0,
                    finishedAt = 2000.0,
                    contentOffset = 0,
                    durationMs = 1000.0
                )
            }
        )
        assertEquals(
            "1 web search, 1 Computer Use action, compacted context, 1 tool call",
            AidenAgentActivityPresentation.summary(multiTimeline)
        )

        val activeThinking = AidenGenerationTimeline(
            version = 3,
            generationId = "gen_thinking",
            status = AidenGenerationTimelineStatus.RUNNING,
            startedAt = 1_000.0,
            steps = listOf(
                thinkStep.copy(
                    order = 0,
                    status = null,
                    finishedAt = null,
                    durationMs = null
                )
            )
        )
        assertTrue(AidenAgentActivityPresentation.hasActiveThinkingStep(activeThinking))
        assertEquals("Thinking", AidenAgentActivityPresentation.reasoningLabel(activeThinking, active = true))

        val visualizing = AidenGenerationTimeline(
            version = 3,
            generationId = "gen_visualizing",
            status = AidenGenerationTimelineStatus.RUNNING,
            startedAt = 1_000.0,
            steps = listOf(
                thinkStep.copy(order = 0),
                AidenAgentStep(
                    id = "tool-1",
                    order = 1,
                    kind = AidenAgentStep.Kind.TOOL,
                    toolCallId = "call-1",
                    toolName = AidenAgentActivityPresentation.RENDER_ARTIFACT_TOOL_NAME,
                    label = "Render artifact",
                    status = AidenAgentStepStatus.RUNNING,
                    startedAt = 2_500.0,
                    updatedAt = 3_000.0,
                    contentOffset = 0
                )
            )
        )
        assertFalse(AidenAgentActivityPresentation.hasActiveThinkingStep(visualizing))
        assertTrue(
            AidenAgentActivityPresentation.hasActiveToolStep(
                visualizing,
                AidenAgentActivityPresentation.RENDER_ARTIFACT_TOOL_NAME
            )
        )
        assertEquals("Visualizing", AidenAgentActivityPresentation.visualizingLabel(visualizing))
        assertEquals("Thought briefly", AidenAgentActivityPresentation.reasoningLabel(visualizing, active = false))
        assertNull(AidenAgentActivityPresentation.visualizingLabel(activeThinking))
    }

    @Test
    fun testProviderArtworkPNGHeaderValidation() {
        val valid1x1PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        val artwork = AidenProviderArtwork(mimeType = "image/png", dataBase64 = valid1x1PNG)
        assertNotNull(artwork.boundedPNGData)

        // Oversized PNG header > 64x64
        val header = ByteArray(24)
        byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10).copyInto(header, 0)
        byteArrayOf(73, 72, 68, 82).copyInto(header, 12)
        header[19] = 65 // width = 65
        header[23] = 1  // height = 1
        val oversizedArtwork = AidenProviderArtwork(
            mimeType = "image/png",
            dataBase64 = Base64.getEncoder().encodeToString(header)
        )
        assertNull(oversizedArtwork.boundedPNGData)
    }

    @Test
    fun testBotReplyProjection() {
        val progress = "Checking the workspace 🍎\n\nI found the destination.\n\n"
        val final = "## Done\n\nThe repository is ready."
        val timeline = AidenGenerationTimeline(
            version = 3,
            generationId = "stream-1",
            status = AidenGenerationTimelineStatus.COMPLETED,
            startedAt = 1000.0,
            finishedAt = 2000.0,
            steps = listOf(
                AidenAgentStep(
                    id = "tool-1",
                    order = 0,
                    kind = AidenAgentStep.Kind.TOOL,
                    toolCallId = "call-1",
                    toolName = "list_dir",
                    label = "List directory",
                    status = AidenAgentStepStatus.COMPLETED,
                    startedAt = 1000.0,
                    updatedAt = 1500.0,
                    finishedAt = 1500.0,
                    contentOffset = 0
                ),
                AidenAgentStep(
                    id = "tool-2",
                    order = 1,
                    kind = AidenAgentStep.Kind.TOOL,
                    toolCallId = "call-2",
                    toolName = "run_command",
                    label = "Run command",
                    status = AidenAgentStepStatus.COMPLETED,
                    startedAt = 1500.0,
                    updatedAt = 2000.0,
                    finishedAt = 2000.0,
                    contentOffset = progress.length,
                    detail = "Clone repository"
                )
            )
        )

        val projection = AidenBotReplyProjection.resolve(
            text = progress + final,
            timeline = timeline,
            isActive = false
        )
        assertEquals(progress.trim(), projection.progressText)
        assertEquals(final, projection.finalText)

        // Active deduplication
        val repeated = "Locating the workspace.\n\nLocating   the workspace.\n\nRunning the clone."
        val activeProjection = AidenBotReplyProjection.resolve(
            text = repeated,
            timeline = null,
            isActive = true
        )
        assertEquals("", activeProjection.finalText)
        assertEquals("Locating the workspace.\n\nRunning the clone.", activeProjection.progressText)
    }

    @Test
    fun testModelOperationApprovalsRequireDesktopInspection() {
        val now = Instant.ofEpochSecond(10_000)
        for (toolName in listOf("generate_image", "classify")) {
            val wire = AidenStreamPendingApproval(
                approvalId = "model-approval", streamId = "stream-1", chatId = "chat-1",
                summary = "Review the complete payload on desktop", toolCallId = "model-call",
                toolName = toolName, expiresAt = now.plusSeconds(60), canAllow = false
            )
            val approval = AidenPendingApprovalResolution.resolve(wire, "stream-1", "chat-1", now = now)!!
            assertTrue(approval.canRespond)
            assertFalse(approval.canAllow)
            assertFalse(approval.hostCanAllow)
            assertEquals(listOf(AidenApprovalScope.ONCE), approval.scopes)
        }
    }

    @Test
    fun testPendingApprovalResolution() {
        val now = Instant.ofEpochSecond(10_000)
        val valid = AidenStreamPendingApproval(
            approvalId = "approval-1",
            streamId = "stream-1",
            chatId = "chat-1",
            summary = "Review",
            toolCallId = "tool-1",
            toolName = "run",
            expiresAt = now.plusSeconds(60),
            canAllow = false
        )

        val resolved = AidenPendingApprovalResolution.resolve(valid, "stream-1", "chat-1", now = now)
        assertNotNull(resolved)
        assertEquals("approval-1", resolved?.id)
        assertEquals("run", resolved?.toolName)
        assertTrue(resolved!!.canRespond)
        assertTrue(resolved.hasRequiredWriteCapability)
        assertFalse(resolved.hostCanAllow)
        assertFalse(resolved!!.canAllow)

        assertNull(AidenPendingApprovalResolution.resolve(null, "stream-1", "chat-1", now = now))
        assertNull(AidenPendingApprovalResolution.resolve(valid, "stream-2", "chat-1", now = now))
        assertNull(AidenPendingApprovalResolution.resolve(valid, "stream-1", "chat-2", now = now))
        assertNull(AidenPendingApprovalResolution.resolve(valid.copy(expiresAt = now), "stream-1", "chat-1", now = now))
    }

    @Test
    fun testApprovalScopesAreOfferedOnlyWhenThisDeviceCanAllowAnAction() {
        val now = Instant.ofEpochSecond(10_000)
        val wire = wireJson.decodeFromString<AidenStreamPendingApproval>(
            """
            {"approvalId":"approval-1","streamId":"stream-1","chatId":"chat-1","summary":"npm test",
            "toolCallId":"tool-1","toolName":"run_command","expiresAt":"1970-01-01T02:47:40.000Z",
            "canAllow":true,"scopes":["always","future-scope","once","chat"]}
            """.trimIndent()
        )

        val allowed = AidenPendingApprovalResolution.resolve(wire, "stream-1", "chat-1", now = now)
        // Unknown names are ignored and the order is canonical, once first.
        assertEquals(
            listOf(AidenApprovalScope.ONCE, AidenApprovalScope.CHAT, AidenApprovalScope.ALWAYS),
            allowed?.scopes
        )
        val reviewOnly = AidenPendingApprovalResolution.resolve(
            wire, "stream-1", "chat-1",
            capabilities = AidenApprovalCapabilities(canRespond = false, canWriteSchedules = true),
            now = now
        )
        assertEquals(listOf(AidenApprovalScope.ONCE), reviewOnly?.scopes)
        assertEquals(
            listOf(AidenApprovalScope.ONCE),
            AidenPendingApprovalResolution.resolve(wire.copy(scopes = null), "stream-1", "chat-1", now = now)?.scopes
        )
    }

    @Test
    fun testApprovalRequestSendsScopeOnlyForBroaderAllows() {
        val remembered = wireJson.encodeToString(
            AidenApprovalRequest.of(AidenApprovalDecision.ALLOW, AidenApprovalScope.CHAT)
        )
        assertEquals("chat", Json.parseToJsonElement(remembered).jsonObject["scope"]?.jsonPrimitive?.content)
        for (body in listOf(
            AidenApprovalRequest.of(AidenApprovalDecision.ALLOW, AidenApprovalScope.ONCE),
            AidenApprovalRequest.of(AidenApprovalDecision.DENY, AidenApprovalScope.ALWAYS),
            AidenApprovalRequest.of(AidenApprovalDecision.ALLOW, null)
        )) {
            assertEquals(setOf("decision"), Json.parseToJsonElement(wireJson.encodeToString(body)).jsonObject.keys)
        }
        val echoed = wireJson.decodeFromString<AidenApprovalResponse>(
            """{"approvalId":"approval-1","decision":"allow","scope":"always","resolvedAt":"2026-08-19T07:00:00.000Z"}"""
        )
        assertEquals(AidenApprovalScope.ALWAYS, echoed.scope)
    }

    @Test
    fun testAutomationApprovalPresentationPreservesHostOnlyConfirmation() {
        val approval = AidenPendingApproval(
            id = "approval-automation",
            summary = "  Create   a daily report  ",
            toolName = "schedule_task",
            expiresAt = Instant.ofEpochSecond(20_000),
            canRespond = true,
            hasRequiredWriteCapability = true,
            hostCanAllow = false,
            canAllow = false
        )

        assertTrue(AidenApprovalPresentation.isAutomation(approval.toolName))
        // Scheduled-task titles match the Mac's card.
        assertEquals("Save this scheduled task?", AidenApprovalPresentation.headline(approval.toolName, approval.summary))
        assertEquals("Change this automation?", AidenApprovalPresentation.headline("edit_automation", approval.summary))
        assertTrue(AidenApprovalPresentation.requiresDesktopConfirmation(approval))
        assertFalse(AidenApprovalPresentation.requiresDesktopConfirmation(approval.copy(hostCanAllow = true, canAllow = true)))
        assertEquals("Approval needed", AidenApprovalPresentation.title("run_command"))
    }

    @Test
    fun testApprovalCardNamesTheActionAndShowsTheExactRequest() {
        // Desktop hosts prefix the request with the tool's name; the title says it instead.
        assertEquals("Run this command?", AidenApprovalPresentation.headline("run_command", "Run command: npm test"))
        assertEquals(
            "find ~/Downloads\n  -type f",
            AidenApprovalPresentation.requestedAction("run_command", "Run command: find ~/Downloads\n  -type f")
        )
        assertEquals("Edit forecast.ts?", AidenApprovalPresentation.headline("edit_file", "Edit file: src/forecast.ts"))
        assertEquals("src/forecast.ts", AidenApprovalPresentation.requestedAction("edit_file", "Edit file: src/forecast.ts"))
        assertEquals("Write todo.md?", AidenApprovalPresentation.headline("write_file", "Create or replace file: notes/todo.md"))
        // The CLI daemon's raw request stays whole when it has no readable form.
        assertEquals("edit: {\"path\":\"a.ts\"}", AidenApprovalPresentation.requestedAction("edit", "edit: {\"path\":\"a.ts\"}"))
        assertEquals("Edit files?", AidenApprovalPresentation.headline("edit", "edit: {\"path\":\"a.ts\"}"))
        assertEquals("Run this command?", AidenApprovalPresentation.headline("bash", "Run command: ls -la"))
        assertEquals("ls -la", AidenApprovalPresentation.requestedAction("bash", "Run command: ls -la"))
        // A prefix is only removed for the tool that writes it.
        assertEquals("Run command: rm -rf /", AidenApprovalPresentation.requestedAction("notion__search", "Run command: rm -rf /"))
        assertEquals("Approval needed", AidenApprovalPresentation.headline("notion__search", "Search Notion"))
        assertEquals("Review requested action", AidenApprovalPresentation.requestedAction("run_command", " \n\t "))
        assertEquals("Run command:", AidenApprovalPresentation.requestedAction("run_command", "Run command: "))
    }

    @Test
    fun testRememberedApprovalsSayWhatTheyCover() {
        // The Mac remembers a command exactly, but a file by its path, whatever the change.
        assertEquals("This exact command, until Aiden quits", AidenApprovalPresentation.scopeDetail(AidenApprovalScope.CHAT, "run_command"))
        assertEquals("This exact command in this workspace", AidenApprovalPresentation.scopeDetail(AidenApprovalScope.ALWAYS, "run_command"))
        assertEquals("Any edit to this file, until Aiden quits", AidenApprovalPresentation.scopeDetail(AidenApprovalScope.CHAT, "edit_file"))
        assertEquals("Any write to this file in this workspace", AidenApprovalPresentation.scopeDetail(AidenApprovalScope.ALWAYS, "write_file"))
        assertNull(AidenApprovalPresentation.scopeDetail(AidenApprovalScope.ONCE, "edit_file"))
    }

    @Test
    fun testDeniedCallsAreSkippedAndPendingApprovalsAreNotCountedAsWork() {
        fun step(index: Int, toolName: String, status: AidenAgentStepStatus) = AidenAgentStep(
            id = "tool-$index",
            order = index,
            kind = AidenAgentStep.Kind.TOOL,
            toolCallId = "call-$index",
            toolName = toolName,
            label = "Tool",
            status = status,
            startedAt = 1000.0,
            updatedAt = 2000.0,
            finishedAt = 2000.0,
            contentOffset = 0,
            durationMs = 1000.0
        )
        fun timeline(status: AidenGenerationTimelineStatus, steps: List<AidenAgentStep>) = AidenGenerationTimeline(
            version = 3,
            generationId = "gen_skipped",
            status = status,
            startedAt = 1000.0,
            finishedAt = if (status == AidenGenerationTimelineStatus.RUNNING) null else 2000.0,
            steps = steps
        )
        // The same sentences as the desktop activity header.
        assertEquals(
            "Skipped 1 command",
            AidenAgentActivityPresentation.summary(
                timeline(AidenGenerationTimelineStatus.COMPLETED, listOf(step(0, "run_command", AidenAgentStepStatus.BLOCKED)))
            )
        )
        assertEquals(
            "Explored 1 file, skipped 2 file changes",
            AidenAgentActivityPresentation.summary(
                timeline(
                    AidenGenerationTimelineStatus.COMPLETED,
                    listOf(
                        step(0, "read_file", AidenAgentStepStatus.COMPLETED),
                        step(1, "edit_file", AidenAgentStepStatus.BLOCKED),
                        step(2, "write_file", AidenAgentStepStatus.BLOCKED)
                    )
                )
            )
        )
        assertEquals(
            "Ran 1 command, skipped 2 actions",
            AidenAgentActivityPresentation.summary(
                timeline(
                    AidenGenerationTimelineStatus.COMPLETED,
                    listOf(
                        step(0, "run_command", AidenAgentStepStatus.COMPLETED),
                        step(1, "run_command", AidenAgentStepStatus.BLOCKED),
                        step(2, "web_fetch", AidenAgentStepStatus.BLOCKED)
                    )
                )
            )
        )
        // A stopped call may have run partway, so it still counts.
        assertEquals(
            "Ran 1 command",
            AidenAgentActivityPresentation.summary(
                timeline(AidenGenerationTimelineStatus.CANCELLED, listOf(step(0, "run_command", AidenAgentStepStatus.CANCELLED)))
            )
        )
        assertEquals(
            "Waiting for approval",
            AidenAgentActivityPresentation.summary(
                timeline(AidenGenerationTimelineStatus.RUNNING, listOf(step(0, "run_command", AidenAgentStepStatus.AWAITING_APPROVAL)))
            )
        )
    }

    @Test
    fun testAutomationApprovalRequiresNegotiatedWriteAndResponseCapabilities() {
        val now = Instant.ofEpochSecond(10_000)
        val valid = AidenStreamPendingApproval(
            approvalId = "approval-1",
            streamId = "stream-1",
            chatId = "chat-1",
            summary = "Create a daily report",
            toolCallId = "tool-1",
            toolName = "schedule_task",
            expiresAt = now.plusSeconds(60),
            canAllow = true
        )

        val allowed = AidenPendingApprovalResolution.resolve(
            valid,
            "stream-1",
            "chat-1",
            capabilities = AidenApprovalCapabilities(canRespond = true, canWriteSchedules = true),
            now = now
        )
        assertTrue(allowed!!.canRespond)
        assertTrue(allowed.hasRequiredWriteCapability)
        assertTrue(allowed.hostCanAllow)
        assertTrue(allowed.canAllow)

        val readOnlySchedule = AidenPendingApprovalResolution.resolve(
            valid,
            "stream-1",
            "chat-1",
            capabilities = AidenApprovalCapabilities(canRespond = true, canWriteSchedules = false),
            now = now
        )
        assertTrue(readOnlySchedule!!.canRespond)
        assertFalse(readOnlySchedule.hasRequiredWriteCapability)
        assertFalse(readOnlySchedule.canAllow)
        assertFalse(AidenApprovalPresentation.requiresDesktopConfirmation(readOnlySchedule))

        val cannotRespond = AidenPendingApprovalResolution.resolve(
            valid,
            "stream-1",
            "chat-1",
            capabilities = AidenApprovalCapabilities(canRespond = false, canWriteSchedules = true),
            now = now
        )
        assertFalse(cannotRespond!!.canRespond)
        assertTrue(cannotRespond.hasRequiredWriteCapability)
        assertFalse(cannotRespond.canAllow)

        val ordinaryAction = AidenPendingApprovalResolution.resolve(
            valid.copy(toolName = "run_command"),
            "stream-1",
            "chat-1",
            capabilities = AidenApprovalCapabilities(canRespond = true, canWriteSchedules = false),
            now = now
        )
        assertTrue(ordinaryAction!!.hasRequiredWriteCapability)
        assertTrue(ordinaryAction.canAllow)
    }

    @Test
    fun queuedHomeWriteCannotReplaceNewerAcceptedChat() {
        val root = File(System.getProperty("java.io.tmpdir"), "aiden-queued-home-${UUID.randomUUID()}").apply { mkdirs() }
        try {
            val cache = AidenChatCache(root = root)
            val initial = sampleChat()
            // Model the closure queued by WorkspaceHome.accept before navigation.
            val token = cache.reserveChatWrite()
            val queuedHomeWrite = Runnable { cache.saveChat(initial, "instance-a", token) }
            val final = initial.copy(title = "Settled title")
            cache.saveChat(final, "instance-a")
            queuedHomeWrite.run()
            assertEquals("Settled title", AidenChatCache(root = root).loadChat("instance-a", initial.id)?.title)
        } finally { root.deleteRecursively() }
    }

    @Test
    fun queuedHomeWriteCannotRecreatePurgedInstallation() {
        val root = File(System.getProperty("java.io.tmpdir"), "aiden-queued-purge-${UUID.randomUUID()}").apply { mkdirs() }
        try {
            val cache = AidenChatCache(root = root)
            val initial = sampleChat()
            val token = cache.reserveChatWrite()
            val queuedHomeWrite = Runnable { cache.saveChat(initial, "instance-a", token) }
            cache.purge("instance-a")
            queuedHomeWrite.run()
            assertNull(AidenChatCache(root = root).loadChat("instance-a", initial.id))
        } finally { root.deleteRecursively() }
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun homeOwnerReservesBeforeQueuedCacheWrite() {
        val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val queued = kotlinx.coroutines.test.StandardTestDispatcher()
        Dispatchers.setMain(dispatcher)
        try {
            runBlocking(dispatcher) {
                for (purging in listOf(false, true)) {
                    val root = File(System.getProperty("java.io.tmpdir"), "aiden-home-owner-${UUID.randomUUID()}").apply { mkdirs() }
                    val viewModels = ViewModelStore()
                    try {
                        val installations = AidenInstallationStore(root, InMemoryAidenSecureStore())
                        installations.addInstallation(AidenPairingExchange(
                            instanceId = "instance-a", deviceId = "device-a",
                            endpoint = "https://aiden.test/api/aiden/v1", serverSpkiSha256 = "sha256/test",
                            credential = "synthetic", capabilities = listOf(AidenRemoteCapability.CHAT_READ)
                        ), null)
                        val cache = AidenChatCache(root = File(root, "cache"))
                        val drafts = AidenChatDraftStore(root)
                        val coordinator = AidenRemoteCoordinator(installations, root, cache, drafts,
                            scope = CoroutineScope(dispatcher + Job().apply { cancel() }))
                        coordinator.refreshClient()
                        val home = sbtbiswas.AidenOnTheGo.features.workspaces.AidenWorkspaceHomeViewModel(
                            coordinator, cache, cacheWriteDispatcher = queued)
                        viewModels.put("home", home)
                        val initial = sampleChat()
                        home.accept(initial)
                        if (purging) cache.purge("instance-a")
                        else cache.saveChat(initial.copy(title = "Settled title"), "instance-a")
                        queued.scheduler.runCurrent()
                        val reopened = AidenChatCache(root = File(root, "cache"))
                        if (purging) assertNull(reopened.loadChat("instance-a", initial.id))
                        else assertEquals("Settled title", reopened.loadChat("instance-a", initial.id)?.title)
                        // Another installation and a fresh post-purge owner remain valid.
                        cache.saveChat(initial, "instance-b")
                        cache.saveChat(initial.copy(title = "New owner"), "instance-a")
                        assertEquals("New owner", reopened.loadChat("instance-a", initial.id)?.title)
                        assertNotNull(reopened.loadChat("instance-b", initial.id))
                    } finally { viewModels.clearAndJoin(); root.deleteRecursively() }
                }
            }
        } finally { Dispatchers.resetMain(); dispatcher.close() }
    }

    @Test
    fun aTitleRefreshHoldingTheEndedRunsReplyRetiresTheLiveCard() {
        assertTitleRefreshAfterTerminal("done", "{\"messageId\":\"final-reply\"}", outcome = null, refreshHoldsReply = true)
    }

    @Test
    fun aTitleRefreshHoldingACancelledRunsPartialReplyRetiresTheLiveCard() {
        assertTitleRefreshAfterTerminal("cancelled", "{\"source\":\"device\"}",
            AidenMessageOutcomeStatus.CANCELLED, refreshHoldsReply = true)
    }

    @Test
    fun aTitleRefreshHoldingAFailedRunsPartialReplyRetiresTheLiveCard() {
        assertTitleRefreshAfterTerminal("error", "{\"code\":\"internal_error\",\"message\":\"Provider failed\"}",
            AidenMessageOutcomeStatus.FAILED, refreshHoldsReply = true)
    }

    @Test
    fun aTitleRefreshWithoutTheCancelledRunsReplyKeepsTheLiveCard() {
        // The chat already ends with an earlier cancelled reply; that one is not this run's.
        assertTitleRefreshAfterTerminal("cancelled", "{\"source\":\"server\"}",
            AidenMessageOutcomeStatus.CANCELLED, refreshHoldsReply = false)
    }

    @Test
    fun aGapReconciliationPublishingTheReplyBeforeTerminalRetiresTheLiveCard() {
        // A mid-run read publishes the reply before the run is cancelled, so the reply
        // is new to the stream even though the chat already held it at the terminal.
        assertGapReconciliationRetiresLiveCard()
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private fun assertTitleRefreshAfterTerminal(
        terminalType: String, terminalPayload: String, outcome: AidenMessageOutcomeStatus?, refreshHoldsReply: Boolean
    ) {
        val directory = kotlin.io.path.createTempDirectory("ended-reply-").toFile()
        val main = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val server = MockWebServer()
        val owners = ViewModelStore()
        val releaseEvents = CountDownLatch(1)
        val releaseRetries = CountDownLatch(1)
        val reads = java.util.concurrent.atomic.AtomicInteger()
        val earlier = listOf(
            AidenChatMessage("earlier-prompt", AidenChatRole.USER, "Earlier", createdAt = Instant.EPOCH),
            AidenChatMessage("earlier-reply", AidenChatRole.ASSISTANT, "Stopped early", createdAt = Instant.EPOCH,
                outcome = AidenMessageOutcome(AidenMessageOutcomeStatus.CANCELLED)))
        val initial = AidenChat(id = "chat-ended", workspaceId = "workspace-ended", title = "Ended", messages = earlier,
            createdAt = Instant.EPOCH, updatedAt = Instant.EPOCH, revision = "r1", titlePending = true)
        val reply = "The final reply"
        val runReply = AidenChatMessage("final-reply", AidenChatRole.ASSISTANT, reply, createdAt = Instant.EPOCH,
            outcome = outcome?.let { AidenMessageOutcome(it) })
        val final = initial.copy(revision = "r2", titlePending = null,
            messages = if (refreshHoldsReply) earlier + runReply else earlier)
        val wire = Json { explicitNulls = false; encodeDefaults = true }
        fun event(sequence: Int, type: String, payload: String, terminal: Boolean = false) =
            "id: $sequence\nevent: $type\ndata: {\"protocolVersion\":1,\"streamId\":\"stream-ended\",\"sequence\":$sequence," +
                "\"timestamp\":\"2026-09-22T00:00:00Z\",\"type\":\"$type\",\"terminal\":$terminal,\"payload\":$payload}\n\n"
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.requestUrl!!.encodedPath.endsWith("/streams/stream-ended/events") -> {
                    releaseEvents.await(5, TimeUnit.SECONDS)
                    MockResponse().setHeader("Content-Type", "text/event-stream").setBody(
                        event(1, "tool_started", "{\"toolId\":\"tool-1\",\"name\":\"read_file\"}") +
                            event(2, "tool_finished", "{\"toolId\":\"tool-1\",\"status\":\"succeeded\"}") +
                            event(3, "text_delta", "{\"text\":\"$reply\"}") +
                            event(4, terminalType, terminalPayload, terminal = true))
                }
                request.requestUrl!!.encodedPath.endsWith("/chats/chat-ended") -> when (reads.incrementAndGet()) {
                    1 -> MockResponse().setBody(wire.encodeToString(initial))
                    // The terminal read fails, so terminal recovery stays pending.
                    2 -> MockResponse().setResponseCode(503).setBody(
                        """{"error":{"code":"internal_error","message":"Held settlement","requestId":"r","retryable":true}}""")
                    // The title refresh reads the chat with the run's reply in it.
                    3 -> MockResponse().setBody(wire.encodeToString(final))
                    else -> {
                        releaseRetries.await(10, TimeUnit.SECONDS)
                        MockResponse().setBody(wire.encodeToString(final))
                    }
                }
                else -> MockResponse().setResponseCode(404)
            }
        }
        server.start()
        Dispatchers.setMain(main)
        var model: AidenChatViewModel? = null
        try {
            runBlocking(main) {
                val installations = AidenInstallationStore(directory, InMemoryAidenSecureStore())
                installations.addInstallation(AidenPairingExchange(instanceId = "instance-ended", deviceId = "device-ended",
                    endpoint = server.url("/api/aiden/v1").toString(), serverSpkiSha256 = "sha256/test", credential = "synthetic",
                    capabilities = listOf(AidenRemoteCapability.CHAT_READ)), null)
                val cache = AidenChatCache(directory)
                cache.saveChat(initial, "instance-ended")
                val drafts = AidenChatDraftStore(directory)
                val coordinator = AidenRemoteCoordinator(installations, directory, cache, drafts,
                    scope = CoroutineScope(main + Job().apply { cancel() }))
                coordinator.refreshClient()
                cache.saveActiveStream(AidenChatCache.ActiveStream("device-ended", "stream-ended", "turn-ended", 0),
                    "instance-ended", initial.id)
                val vm = AidenChatViewModel(initial.id, coordinator, cache, drafts, initial)
                model = vm
                owners.put("chat", vm)
                withTimeout(5_000) { vm.isLoading.first { !it } }
                releaseEvents.countDown()
                withTimeout(5_000) { vm.presentedError.first { it == "Held settlement" } }
                assertEquals("the ended run keeps its card while its transcript is unread", reply, vm.liveText.value)
                assertEquals(listOf("tool-1"), vm.tools.value.map { it.id })

                withTimeout(5_000) { vm.chat.first { it?.revision == "r2" } }
                assertEquals(final.messages.map { it.id }, vm.chat.value?.messages?.map { it.id })
                // The screen keeps the card while any live output remains, tool rows included.
                val hasLiveOutput = vm.liveText.value.isNotEmpty() || vm.reasoning.value.isNotEmpty() || vm.tools.value.isNotEmpty()
                val showsLiveCard = AidenChatScroll.showsLiveCard(vm.streamState.value, hasLiveOutput)
                if (refreshHoldsReply) {
                    assertFalse("the reply must not show twice", showsLiveCard)
                    assertFalse(vm.hasActiveStream.value)
                    assertNull("the settled run clears its recovery warning", vm.presentedError.value)
                } else {
                    assertTrue("the run's output stays visible until its reply is read", showsLiveCard)
                    assertEquals(reply, vm.liveText.value)
                    assertTrue(vm.hasActiveStream.value)
                }
            }
        } finally {
            releaseEvents.countDown()
            releaseRetries.countDown()
            runBlocking(main) {
                val job = model?.viewModelScope?.coroutineContext?.get(Job)
                owners.clear()
                job?.join()
            }
            Dispatchers.resetMain()
            main.close()
            server.shutdown()
            directory.deleteRecursively()
        }
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private fun assertGapReconciliationRetiresLiveCard() {
        val directory = kotlin.io.path.createTempDirectory("gap-reconcile-").toFile()
        val main = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val server = MockWebServer()
        val owners = ViewModelStore()
        val scopeJob = Job()
        val releaseEvents = CountDownLatch(1)
        val gapRead = java.util.concurrent.atomic.AtomicBoolean(false)
        val terminalFailed = java.util.concurrent.atomic.AtomicBoolean(false)
        val earlier = listOf(
            AidenChatMessage("earlier-prompt", AidenChatRole.USER, "Earlier", createdAt = Instant.EPOCH),
            AidenChatMessage("earlier-reply", AidenChatRole.ASSISTANT, "Stopped early", createdAt = Instant.EPOCH,
                outcome = AidenMessageOutcome(AidenMessageOutcomeStatus.CANCELLED)))
        val initial = AidenChat(id = "chat-gap", workspaceId = "workspace-gap", title = "Gap", messages = earlier,
            createdAt = Instant.EPOCH, updatedAt = Instant.EPOCH, revision = "r1", titlePending = true)
        val reply = "The final reply"
        val runReply = AidenChatMessage("final-reply", AidenChatRole.ASSISTANT, reply, createdAt = Instant.EPOCH,
            outcome = AidenMessageOutcome(AidenMessageOutcomeStatus.CANCELLED))
        val withReply = initial.copy(revision = "r2", messages = earlier + runReply)
        val final = withReply.copy(revision = "r3", titlePending = null)
        val grants = listOf(AidenRemoteCapability.SERVER_READ, AidenRemoteCapability.CHAT_READ)
        val features = listOf(AidenRemoteProtocol.CHAT_MESSAGES_WINDOW_FEATURE, AidenRemoteProtocol.CHAT_MESSAGES_WINDOW_METADATA_FEATURE)
        val wire = Json { explicitNulls = false; encodeDefaults = true }
        fun window(chat: AidenChat) = MockResponse().setBody(wire.encodeToString(AidenChatMessagesWindow(
            chat.id, chat.revision, chat.messages, hasOlder = false, workspaceId = chat.workspaceId, title = chat.title,
            titlePending = chat.titlePending, createdAt = chat.createdAt, updatedAt = chat.updatedAt)))
        fun event(sequence: Int, type: String, payload: String, terminal: Boolean = false) =
            "id: $sequence\nevent: $type\ndata: {\"protocolVersion\":1,\"streamId\":\"stream-gap\",\"sequence\":$sequence," +
                "\"timestamp\":\"2026-09-22T00:00:00Z\",\"type\":\"$type\",\"terminal\":$terminal,\"payload\":$payload}\n\n"
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (val path = request.requestUrl!!.encodedPath) {
                "/api/aiden/v1/server" -> MockResponse().setBody("""{"protocolVersion":1,"instanceId":"instance-gap","name":"Gap Mac","appVersion":"1.0","capabilities":${json.encodeToString(grants)},"serverCapabilities":${json.encodeToString(grants)},"features":${json.encodeToString(features)},"connectionMode":"lan","serverTime":"2026-10-05T10:00:00Z"}""")
                "/api/aiden/v1/streams/stream-gap/events" -> {
                    releaseEvents.await(5, TimeUnit.SECONDS)
                    // Sequences 2 and 3 are missing, so the client reads the transcript mid-run.
                    MockResponse().setHeader("Content-Type", "text/event-stream").setBody(
                        event(1, "tool_started", "{\"toolId\":\"tool-1\",\"name\":\"read_file\"}") +
                            event(4, "text_delta", "{\"text\":\"$reply\"}") +
                            event(5, "cancelled", "{\"source\":\"device\"}", terminal = true))
                }
                // Transcript reads page the latest messages. The gap read already holds
                // the run's reply; the terminal read and every retry of it fail.
                "/api/aiden/v1/chats/chat-gap/messages" -> when {
                    releaseEvents.count > 0 -> window(initial)
                    gapRead.compareAndSet(false, true) -> window(withReply)
                    else -> {
                        terminalFailed.set(true)
                        MockResponse().setResponseCode(503).setBody(
                            """{"error":{"code":"internal_error","message":"Terminal failed","requestId":"r","retryable":true}}""")
                    }
                }
                // Only the title refresh reads the whole chat; its title settles after the run.
                "/api/aiden/v1/chats/chat-gap" -> MockResponse().setBody(wire.encodeToString(when {
                    terminalFailed.get() -> final
                    releaseEvents.count > 0 -> initial
                    else -> withReply
                }))
                else -> MockResponse().setResponseCode(404)
            }
        }
        server.start()
        Dispatchers.setMain(main)
        var model: AidenChatViewModel? = null
        try {
            runBlocking(main) {
                val installations = AidenInstallationStore(directory, InMemoryAidenSecureStore())
                installations.addInstallation(AidenPairingExchange(instanceId = "instance-gap", deviceId = "device-gap",
                    endpoint = server.url("/api/aiden/v1").toString(), serverSpkiSha256 = "sha256/test", credential = "synthetic",
                    capabilities = grants), null)
                val cache = AidenChatCache(directory)
                cache.saveChat(initial, "instance-gap")
                val drafts = AidenChatDraftStore(directory)
                val coordinator = AidenRemoteCoordinator(installations, directory, cache, drafts, scope = CoroutineScope(main + scopeJob))
                coordinator.refreshClient()
                withTimeout(5_000) { coordinator.serverInfo.first { it != null } }
                cache.saveActiveStream(AidenChatCache.ActiveStream("device-gap", "stream-gap", "turn-gap", 0),
                    "instance-gap", initial.id)
                val vm = AidenChatViewModel(initial.id, coordinator, cache, drafts, initial)
                model = vm
                owners.put("chat", vm)
                withTimeout(5_000) { vm.isLoading.first { !it } }
                releaseEvents.countDown()
                withTimeout(5_000) { vm.presentedError.first { it == "Terminal failed" } }
                assertEquals("the mid-run read already published the reply", earlier.map { it.id } + "final-reply",
                    vm.chat.value?.messages?.map { it.id })
                assertEquals(reply, vm.liveText.value)

                // Terminal recovery never gets a page, but the title refresh reads the
                // reply, so the cancelled run's card goes and the reply shows once.
                withTimeout(10_000) { vm.liveText.first { it.isEmpty() } }
                val hasLiveOutput = vm.liveText.value.isNotEmpty() || vm.reasoning.value.isNotEmpty() || vm.tools.value.isNotEmpty()
                assertFalse(AidenChatScroll.showsLiveCard(vm.streamState.value, hasLiveOutput))
                assertFalse(vm.hasActiveStream.value)
                assertNull(vm.presentedError.value)
            }
        } finally {
            releaseEvents.countDown()
            runBlocking(main) {
                val job = model?.viewModelScope?.coroutineContext?.get(Job)
                owners.clear()
                job?.join()
            }
            scopeJob.cancel()
            Dispatchers.resetMain()
            main.close()
            server.shutdown()
            directory.deleteRecursively()
        }
    }

    @Test
    fun testChatCachePartitionAndActiveStream() {
        val tempDir = File(System.getProperty("java.io.tmpdir"), "aiden-cache-test-${UUID.randomUUID()}").apply { mkdirs() }
        try {
            val cache = AidenChatCache(root = tempDir)
            val chat = sampleChat()

            cache.saveChats(listOf(chat), "instance-a", "workspace-1")
            cache.saveChat(chat, "instance-a")
            cache.saveActiveStream(
                AidenChatCache.ActiveStream(deviceId = "device-a", streamId = "stream-1", turnId = "turn-1", lastSequence = 14),
                instanceId = "instance-a",
                chatId = chat.id
            )

            val chatsA = cache.loadChats("instance-a", "workspace-1")
            val chatA = cache.loadChat("instance-a", chat.id)
            val streamA = cache.loadActiveStream("instance-a", chat.id)

            assertEquals(listOf(chat), chatsA)
            assertEquals(chat, chatA)
            assertEquals("stream-1", streamA?.streamId)
            assertEquals(14, streamA?.lastSequence)

            // Isolation from instance-b
            val chatB = cache.loadChat("instance-b", chat.id)
            assertNull(chatB)

            // Purge instance-a
            cache.purge("instance-a")
            assertNull(cache.loadChat("instance-a", chat.id))
            assertNull(cache.loadActiveStream("instance-a", chat.id))
        } finally {
            tempDir.deleteRecursively()
        }
    }

    @Test
    fun testAttachmentImageCacheIsScopedByInstallationDeviceAndChat() {
        val tempDir = File(System.getProperty("java.io.tmpdir"), "aiden-image-cache-test-${UUID.randomUUID()}").apply { mkdirs() }
        try {
            val cache = AidenChatCache(root = tempDir)
            val bytes = Base64.getDecoder().decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
            )
            val attachment = AidenMessageAttachment(
                id = "image-1",
                name = "photo.png",
                mimeType = "image/png",
                kind = AidenAttachmentKind.IMAGE,
                size = bytes.size
            )

            cache.saveAttachmentImage(bytes, "instance-a", "device-a", "chat-a", attachment)
            assertArrayEquals(bytes, cache.attachmentImage("instance-a", "device-a", "chat-a", attachment))
            assertNull(cache.attachmentImage("instance-a", "device-b", "chat-a", attachment))
            assertNull(cache.attachmentImage("instance-a", "device-a", "chat-b", attachment))
            assertNull(cache.attachmentImage("instance-b", "device-a", "chat-a", attachment))

            cache.removeAttachmentImage("instance-a", "device-a", "chat-a", attachment.id)
            assertNull(cache.attachmentImage("instance-a", "device-a", "chat-a", attachment))
        } finally {
            tempDir.deleteRecursively()
        }
    }

    @Test
    fun testDraftStoreOptimisticGenerationTracking() {
        val tempDir = File(System.getProperty("java.io.tmpdir"), "aiden-drafts-test-${UUID.randomUUID()}").apply { mkdirs() }
        try {
            val store = AidenChatDraftStore(root = tempDir)
            val session1 = store.beginSession("inst-1", "chat-1")
            assertEquals(1L, session1.generation)

            assertTrue(store.save("Hello draft", session1))
            assertEquals("Hello draft", store.load(session1))

            // Beginning a new session invalidates older session saves
            val session2 = store.beginSession("inst-1", "chat-1")
            assertEquals(2L, session2.generation)

            assertFalse(store.save("Stale overwrite", session1))
            assertEquals("Hello draft", store.load(session2))

            assertTrue(store.save("Fresh text", session2))
            assertEquals("Fresh text", store.load(session2))
        } finally {
            tempDir.deleteRecursively()
        }
    }

    @Test
    fun testDraftStoreConsumesAdmittedRunInputFromAnOlderSession() {
        val tempDir = File(System.getProperty("java.io.tmpdir"), "aiden-drafts-test-${UUID.randomUUID()}").apply { mkdirs() }
        try {
            val store = AidenChatDraftStore(root = tempDir)
            val submitting = store.beginSession("inst-1", "chat-1")
            assertTrue(store.save("Fix the tests\nthen ship", submitting))
            val otherMac = store.beginSession("inst-2", "chat-1")
            assertTrue(store.save("Fix the tests", otherMac))

            // The chat was reopened before the Mac admitted the input: the older session still
            // retires the admitted text, and only that text.
            val reopened = store.beginSession("inst-1", "chat-1")
            store.consumeDraft("Fix the tests", "Fix the tests\nthen ship", submitting)
            assertEquals("then ship", store.load(reopened))
            assertEquals("Fix the tests", store.load(otherMac))

            // A draft typed after the composer cleared is a different draft, even when it starts
            // with the admitted text.
            assertTrue(store.save("then ship it today", reopened))
            store.consumeDraft("then ship", "then ship", submitting)
            assertEquals("then ship it today", store.load(reopened))

            store.consumeDraft("then ship it today", "then ship it today", submitting)
            assertNull(store.load(reopened))
            // Nothing saved: nothing is written back.
            store.consumeDraft("anything", "anything", submitting)
            assertNull(store.load(reopened))
        } finally {
            tempDir.deleteRecursively()
        }
    }

    private fun sampleChat(): AidenChat {
        return AidenChat(
            id = "chat-1",
            workspaceId = "workspace-1",
            title = "Aiden chat",
            providerId = "openai",
            modelId = "gpt-5.6",
            messages = listOf(
                AidenChatMessage(
                    id = "msg-1",
                    role = AidenChatRole.USER,
                    text = "Hello",
                    createdAt = Instant.ofEpochSecond(1_787_100_000)
                )
            ),
            createdAt = Instant.ofEpochSecond(1_787_100_000),
            updatedAt = Instant.ofEpochSecond(1_787_100_001),
            revision = "revision-1"
        )
    }

    @Test
    fun currentChatRecallUsesFixedPrivateActivityLabel() {
        val browserLabels = mapOf(
            "browser" to "Loaded browser tools",
            "browser_status" to "Checked browser",
            "browser_open" to "Opened browser",
            "browser_navigate" to "Navigated browser",
            "browser_resize" to "Resized browser",
            "browser_set_appearance" to "Set browser appearance",
            "browser_snapshot" to "Inspected browser",
            "browser_click" to "Clicked in browser",
            "browser_type" to "Typed in browser",
            "browser_press" to "Pressed browser keys",
            "browser_scroll" to "Scrolled browser",
            "browser_evaluate" to "Evaluated page",
            "browser_wait_for" to "Waited for page",
            "browser_recording_start" to "Started browser recording",
            "browser_recording_stop" to "Stopped browser recording",
            "device_list" to "Listed simulators",
            "device_open" to "Opened simulator",
            "device_screenshot" to "Took simulator screenshot",
            "device_close" to "Closed simulator"
        )
        for ((name, expected) in browserLabels) {
            val browserStep = AidenAgentStep(
                id = name, order = 0, kind = AidenAgentStep.Kind.TOOL,
                toolName = name, label = name,
                status = AidenAgentStepStatus.COMPLETED, startedAt = 1000.0,
                updatedAt = 2000.0, finishedAt = 2000.0, contentOffset = 0,
                durationMs = 1000.0
            )
            assertEquals(expected, AidenAgentActivityPresentation.line(browserStep))
        }
        val step = AidenAgentStep(
            id = "recall-1", order = 0, kind = AidenAgentStep.Kind.TOOL,
            toolName = "vcc_recall", label = "Recall chat history",
            status = AidenAgentStepStatus.COMPLETED, startedAt = 1000.0,
            updatedAt = 2000.0, finishedAt = 2000.0, contentOffset = 0,
            durationMs = 1000.0
        )
        assertEquals("Recalled chat history", AidenAgentActivityPresentation.line(step))
    }

    @Test
    fun pendingToolCallReadsAsPreparingUntilItRuns() {
        val pending = AidenAgentStep(
            id = "read-pending", order = 0, kind = AidenAgentStep.Kind.TOOL,
            toolName = "read_file", label = "Read file",
            status = AidenAgentStepStatus.PENDING, startedAt = 1000.0,
            updatedAt = 1000.0, contentOffset = 0, target = "src/app.ts"
        )
        assertEquals("Preparing Read file", AidenAgentActivityPresentation.line(pending))
        val running = pending.copy(status = AidenAgentStepStatus.RUNNING, updatedAt = 1200.0)
        assertEquals("Reading src/app.ts", AidenAgentActivityPresentation.line(running))
    }

    @Test
    fun compactionMetricsUseExistingActivityDetail() {
        val step = AidenAgentStep(
            id = "compact-1", order = 0, kind = AidenAgentStep.Kind.TOOL,
            toolName = "compact_context", label = "Compact context",
            status = AidenAgentStepStatus.COMPLETED, startedAt = 1000.0,
            updatedAt = 2000.0, finishedAt = 2000.0, contentOffset = 0,
            durationMs = 1000.0, detail = "pi-vcc · 0.4s · ~25900 → 6758 tokens"
        )
        assertEquals("Compacted context pi-vcc · 0.4s · ~25900 → 6758 tokens", AidenAgentActivityPresentation.line(step))
        assertTrue(AidenAgentActivityPresentation.isCompactContextOnly(listOf(step)))
        val read = AidenAgentStep(
            id = "read-1", order = 1, kind = AidenAgentStep.Kind.TOOL,
            toolName = "read_file", label = "Read file",
            status = AidenAgentStepStatus.COMPLETED, startedAt = 1000.0,
            updatedAt = 2000.0, finishedAt = 2000.0, contentOffset = 0,
            durationMs = 1000.0, target = "README.md"
        )
        assertFalse(AidenAgentActivityPresentation.isCompactContextOnly(listOf(step, read)))
        assertFalse(AidenAgentActivityPresentation.isCompactContextOnly(listOf(step, step.copy(id = "compact-2", order = 1))))
        assertFalse(AidenAgentActivityPresentation.isCompactContextOnly(emptyList()))
        assertEquals(step.detail, json.decodeFromString<AidenAgentStep>(json.encodeToString(step)).detail)
    }

    // --- Chat fork (contract revision 21) ---

    @Test
    fun forkEligibilityOffersOnlyTheCutsTheMacAccepts() {
        val at = Instant.EPOCH
        val running = AidenGenerationTimeline(
            version = 3, generationId = "stream-running", status = AidenGenerationTimelineStatus.RUNNING,
            startedAt = 1.0, steps = emptyList()
        )
        val messages = listOf(
            AidenChatMessage("assistant-greeting", AidenChatRole.ASSISTANT, "Hello", createdAt = at),
            AidenChatMessage("user-1", AidenChatRole.USER, "One", createdAt = at),
            AidenChatMessage("assistant-1", AidenChatRole.ASSISTANT, "Reply one", createdAt = at),
            AidenChatMessage("user-2", AidenChatRole.USER, "Two", createdAt = at),
            AidenChatMessage("assistant-2", AidenChatRole.ASSISTANT, "Reply two", createdAt = at),
            AidenChatMessage("local-user-3", AidenChatRole.USER, "Three", createdAt = at),
            AidenChatMessage("assistant-3", AidenChatRole.ASSISTANT, "Working", timeline = running, createdAt = at)
        )
        val eligibility = AidenChatForkEligibility

        assertFalse("A reply before any prompt keeps nothing", eligibility.canForkFrom(messages, "assistant-greeting"))
        assertTrue(eligibility.canForkFrom(messages, "assistant-1"))
        assertTrue(eligibility.canForkWithSummary(messages, "assistant-1"))
        assertFalse("A running reply is not settled", eligibility.canForkFrom(messages, "assistant-3"))
        assertFalse(eligibility.canForkFrom(messages, "user-2"))
        assertFalse(eligibility.canForkFrom(messages, "missing"))

        assertFalse("The first prompt has nothing before it", eligibility.canEditInFork(messages, "user-1"))
        assertTrue(eligibility.canEditInFork(messages, "user-2"))
        assertFalse("An unsent prompt is not on the Mac", eligibility.canEditInFork(messages, "local-user-3"))
        assertFalse(eligibility.canEditInFork(messages, "assistant-1"))

        val settled = messages.take(5)
        assertTrue(eligibility.canForkFrom(settled, "assistant-2"))
        assertFalse("Nothing follows the last reply to summarize", eligibility.canForkWithSummary(settled, "assistant-2"))
    }

    @Test
    fun editInForkOpensTheForkWithItsPromptAndAttachmentsStaged() {
        val attachment = AidenAttachmentReference(
            id = "att_" + "A".repeat(43), name = "notes.txt", mimeType = "text/plain",
            kind = AidenAttachmentKind.TEXT, size = 12, expiresAt = Instant.now().plusSeconds(600)
        )
        val expired = attachment.copy(id = "att_" + "B".repeat(43), expiresAt = Instant.now().minusSeconds(60))
        val fork = forkChat(lineage = AidenChatForkLineage(
            chatId = forkSource.id, messageId = "user-2", position = AidenChatForkPosition.BEFORE, at = Instant.EPOCH
        ))
        val forkRequests = java.util.concurrent.LinkedBlockingQueue<RecordedRequest>()
        withForkHarness(listOf("chat-fork-v1", "chat-fork-summary-v1"), { request ->
            when (request.requestUrl!!.encodedPath) {
                "/api/aiden/v1/chats/${forkSource.id}/fork" -> {
                    forkRequests.add(request)
                    MockResponse().setResponseCode(201).setBody(forkWireJson.encodeToString(
                        AidenChatForkResult(fork, AidenChatForkPrefill("Try the streaming parser.", listOf(attachment, expired)))
                    ))
                }
                "/api/aiden/v1/chats/${forkSource.id}" -> MockResponse().setBody(forkWireJson.encodeToString(forkSource))
                "/api/aiden/v1/chats/${fork.id}" -> MockResponse().setBody(forkWireJson.encodeToString(fork))
                else -> null
            }
        }) { harness ->
            val model = harness.open(forkSource.id, forkSource)
            assertTrue(model.canFork)

            model.fork("user-2", AidenChatForkPosition.BEFORE)

            assertEquals(fork.id, withTimeout(5_000) { model.forkNavigation.first { it != null } })
            val request = withContext(Dispatchers.IO) { forkRequests.poll(5, TimeUnit.SECONDS) }!!
            assertEquals("source-r1", request.getHeader("If-Match"))
            val body = json.parseToJsonElement(request.body.readUtf8()).jsonObject
            assertEquals("user-2", body.getValue("messageId").jsonPrimitive.content)
            assertEquals("before", body.getValue("position").jsonPrimitive.content)
            assertFalse("Edit in fork never asks for a summary", body.containsKey("summary"))
            model.consumeForkNavigation(fork.id)
            assertNull(model.forkNavigation.value)

            // The fork's composer opens with the prompt and its still-valid attachments.
            val forkModel = harness.open(fork.id)
            assertEquals("Try the streaming parser.", forkModel.draft.value)
            assertEquals(listOf(attachment.id), forkModel.pendingAttachments.value.map { it.id })
            assertEquals(
                AidenChatForkSource.Named(forkSource.id, forkSource.title),
                withTimeout(5_000) { forkModel.forkSource.first { it is AidenChatForkSource.Named } }
            )
            // Staged attachments belong to that one composer.
            val reopened = harness.open(fork.id)
            assertTrue(reopened.pendingAttachments.value.isEmpty())
        }
    }

    @Test
    fun aPendingForkSummaryHoldsTurnsUntilItIsSkipped() {
        val pending = forkChat(lineage = AidenChatForkLineage(
            chatId = forkSource.id, messageId = "assistant-1", position = AidenChatForkPosition.AFTER, at = Instant.EPOCH,
            summary = AidenChatForkSummary(
                state = AidenChatForkSummaryState.PENDING, afterMessageId = "fork-assistant-1", focus = "the parser"
            )
        ))
        val remoteFork = java.util.concurrent.atomic.AtomicReference(pending)
        val forkBodies = java.util.concurrent.LinkedBlockingQueue<String>()
        withForkHarness(listOf("chat-fork-v1", "chat-fork-summary-v1"), { request ->
            when (request.requestUrl!!.encodedPath) {
                "/api/aiden/v1/chats/${forkSource.id}/fork" -> {
                    forkBodies.add(request.body.readUtf8())
                    MockResponse().setResponseCode(201).setBody(forkWireJson.encodeToString(AidenChatForkResult(pending)))
                }
                "/api/aiden/v1/chats/${forkSource.id}" -> MockResponse().setBody(forkWireJson.encodeToString(forkSource))
                "/api/aiden/v1/chats/${pending.id}" -> MockResponse().setBody(forkWireJson.encodeToString(remoteFork.get()))
                "/api/aiden/v1/chats/${pending.id}/fork-summary/skip" -> {
                    val skipped = remoteFork.get().let { it.copy(revision = "fork-r2", forkedFrom = it.forkedFrom!!.copy(summary = null)) }
                    remoteFork.set(skipped)
                    MockResponse().setBody(forkWireJson.encodeToString(skipped))
                }
                else -> null
            }
        }) { harness ->
            val model = harness.open(forkSource.id, forkSource)
            assertTrue(model.canForkWithSummary)
            model.fork("assistant-1", AidenChatForkPosition.AFTER, withSummary = true, summaryFocus = "  the parser  ")
            assertEquals(pending.id, withTimeout(5_000) { model.forkNavigation.first { it != null } })
            val body = json.parseToJsonElement(withContext(Dispatchers.IO) { forkBodies.poll(5, TimeUnit.SECONDS) }!!).jsonObject
            assertEquals(
                Json.parseToJsonElement("""{"focus":"the parser"}"""),
                body.getValue("summary")
            )

            val forkModel = harness.open(pending.id)
            forkModel.updateDraft("Carry on")
            assertTrue(forkModel.isHeldByForkSummary)
            assertFalse("A pending summary holds new turns", forkModel.canSend)
            assertTrue(forkModel.canManageForkSummary)

            forkModel.skipForkSummary()
            withTimeout(5_000) { forkModel.chat.first { it?.forkedFrom?.summary == null } }
            assertFalse(forkModel.isHeldByForkSummary)
            assertTrue(forkModel.canSend)
        }
    }

    @Test
    fun forkActionsStayHiddenWithoutTheMacFeatures() {
        withForkHarness(listOf("chat-fork-v1"), { request ->
            when (request.requestUrl!!.encodedPath) {
                "/api/aiden/v1/chats/${forkSource.id}" -> MockResponse().setBody(forkWireJson.encodeToString(forkSource))
                else -> null
            }
        }) { harness ->
            val model = harness.open(forkSource.id, forkSource)
            assertTrue(model.canFork)
            assertFalse("Summaries need chat-fork-summary-v1", model.canForkWithSummary)
            // fork() marks itself busy before it sends, so a refused request is visible at once.
            model.fork("assistant-1", AidenChatForkPosition.AFTER, withSummary = true)
            assertFalse(model.isForking.value)
            assertFalse(harness.paths().any { it.endsWith("/fork") })
        }
        withForkHarness(emptyList(), { request ->
            when (request.requestUrl!!.encodedPath) {
                "/api/aiden/v1/chats/${forkSource.id}" -> MockResponse().setBody(forkWireJson.encodeToString(forkSource))
                else -> null
            }
        }) { harness ->
            val model = harness.open(forkSource.id, forkSource)
            assertFalse("An older Mac cannot fork", model.canFork)
        }
    }

    @Test
    fun unpairingDuringTheForkHandoffLeavesNothingOfTheFork() {
        val attachment = AidenAttachmentReference(
            id = "att_" + "C".repeat(43), name = "notes.txt", mimeType = "text/plain",
            kind = AidenAttachmentKind.TEXT, size = 12, expiresAt = Instant.now().plusSeconds(600)
        )
        val fork = forkChat(lineage = AidenChatForkLineage(
            chatId = forkSource.id, messageId = "user-2", position = AidenChatForkPosition.BEFORE, at = Instant.EPOCH
        ))
        val io = HoldableDispatcher()
        try {
            withForkHarness(listOf("chat-fork-v1"), { request ->
                when (request.requestUrl!!.encodedPath) {
                    "/api/aiden/v1/chats/${forkSource.id}/fork" -> {
                        // Hold the view model's IO from the moment the Mac answers.
                        io.hold()
                        MockResponse().setResponseCode(201).setBody(forkWireJson.encodeToString(
                            AidenChatForkResult(fork, AidenChatForkPrefill("Try the streaming parser.", listOf(attachment)))
                        ))
                    }
                    "/api/aiden/v1/chats/${forkSource.id}" -> MockResponse().setBody(forkWireJson.encodeToString(forkSource))
                    else -> null
                }
            }) { harness ->
                val model = harness.open(forkSource.id, forkSource, ioDispatcher = io)
                model.fork("user-2", AidenChatForkPosition.BEFORE)
                assertTrue(
                    "The fork handoff reached its IO",
                    withContext(Dispatchers.IO) { io.awaitHeld(5, TimeUnit.SECONDS) }
                )

                harness.unpair()
                io.release()
                withTimeout(5_000) { model.isForking.first { !it } }

                assertNull("A removed pairing opens no fork", model.forkNavigation.value)
                assertNull(harness.cache.loadChat("instance-fork", fork.id))
                assertNull(harness.cache.admittedChat("instance-fork", fork.id))
                assertNull(harness.drafts.getDraft("instance-fork", fork.id))
                assertTrue(harness.drafts.takeStagedAttachments("instance-fork", fork.id).isEmpty())
            }
        } finally {
            io.close()
        }
    }

    private fun rateLimitedTurn(retryable: Boolean, message: String = "Aiden Agent is busy.", retryAfterSeconds: Int? = null) =
        MockResponse().setResponseCode(429).setBody(
            """{"error":{"code":"rate_limited","message":"$message","requestId":"req-busy","retryable":$retryable""" +
                (retryAfterSeconds?.let { ""","details":{"retryAfterSeconds":$it}""" } ?: "") + "}}"
        )

    private fun acceptedTurn(n: Int) = MockResponse().setResponseCode(202).setBody(
        """{"turnId":"turn-$n","streamId":"stream-$n","status":"queued","message":${forkWireJson.encodeToString(
            AidenChatMessage("accepted-$n", AidenChatRole.USER, "Hello", createdAt = Instant.EPOCH.plusSeconds(10))
        )}}"""
    )

    /** Routes the send endpoints, answering each turn POST with [answer] by its 1-based count. */
    private fun withTurnHarness(
        answer: (Int) -> MockResponse,
        block: suspend CoroutineScope.(AidenChatViewModel, java.util.concurrent.LinkedBlockingQueue<RecordedRequest>, CountDownLatch) -> Unit,
        expectedTurns: Int
    ) {
        val turns = java.util.concurrent.LinkedBlockingQueue<RecordedRequest>()
        val arrived = CountDownLatch(expectedTurns)
        val count = java.util.concurrent.atomic.AtomicInteger(0)
        withForkHarness(emptyList(), { request ->
            val path = request.requestUrl!!.encodedPath
            when {
                path == "/api/aiden/v1/chats/${forkSource.id}/turns" -> {
                    turns.add(request)
                    answer(count.incrementAndGet()).also { arrived.countDown() }
                }
                path == "/api/aiden/v1/chats/${forkSource.id}" -> MockResponse().setBody(forkWireJson.encodeToString(forkSource))
                path.endsWith("/events") -> MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE)
                else -> null
            }
        }) { harness ->
            val model = harness.open(forkSource.id, forkSource)
            block(model, turns, arrived)
        }
    }

    @Test
    fun aBusyMacSendIsResentAfterTheServerDelayUnderAFreshKey() = withTurnHarness(
        answer = { n -> if (n == 1) rateLimitedTurn(retryable = true, retryAfterSeconds = 4) else acceptedTurn(n) },
        expectedTurns = 2,
        block = { model, turns, _ ->
            val waits = java.util.concurrent.CopyOnWriteArrayList<Long>()
            model.rateLimitedSendRetryDelay = { waits += it; yield() }
            model.updateDraft("Hello")
            model.send()
            withTimeout(5_000) { model.chat.first { chat -> chat?.messages?.any { it.id == "accepted-2" } == true } }

            assertEquals("the resend waits the server's Retry-After", listOf(4_000L), waits)
            val refused = turns.poll()!!
            val resent = turns.poll()!!
            assertNull(turns.poll())
            // The Mac settled the refused key as rejected, so only a fresh key can carry the resend.
            assertNotEquals(refused.getHeader("Idempotency-Key"), resent.getHeader("Idempotency-Key"))
            assertEquals(refused.body.readUtf8(), resent.body.readUtf8())
            assertNull("a busy Mac is not reported as a failed send", model.presentedError.value)
            assertNull(model.pendingSend.value)
            assertFalse(model.isWaitingToRetryRateLimitedSend.value)
            assertEquals("", model.draft.value)
        }
    )

    @Test
    fun busyMacResendsStopAfterTheirLimitAndLeaveRetryToThePerson() = withTurnHarness(
        answer = { n -> if (n <= 1 + AidenChatViewModel.MAX_RATE_LIMITED_SEND_RETRIES) rateLimitedTurn(retryable = true) else acceptedTurn(n) },
        expectedTurns = 1 + AidenChatViewModel.MAX_RATE_LIMITED_SEND_RETRIES,
        block = { model, turns, arrived ->
            val waits = java.util.concurrent.CopyOnWriteArrayList<Long>()
            model.rateLimitedSendRetryDelay = { waits += it; yield() }
            model.updateDraft("Hello")
            model.send()
            withContext(Dispatchers.IO) { check(arrived.await(5, TimeUnit.SECONDS)) }
            withTimeout(5_000) { model.isStarting.first { !it } }

            assertEquals(AidenChatViewModel.MAX_RATE_LIMITED_SEND_RETRIES, waits.size)
            assertFalse(model.isWaitingToRetryRateLimitedSend.value)
            assertNull(model.presentedError.value)
            assertTrue("the send stays saved for the person's Retry", model.pendingSend.value?.canRetry() == true)
            assertTrue(model.canRetrySend)

            model.send(retry = true)
            val acceptedId = "accepted-${AidenChatViewModel.MAX_RATE_LIMITED_SEND_RETRIES + 2}"
            withTimeout(5_000) { model.chat.first { chat -> chat?.messages?.any { it.id == acceptedId } == true } }
            val keys = turns.map { it.getHeader("Idempotency-Key") }
            assertEquals(AidenChatViewModel.MAX_RATE_LIMITED_SEND_RETRIES + 2, keys.size)
            assertEquals("every refused attempt was replaced by a fresh key", keys.size, keys.toSet().size)
            assertNull(model.pendingSend.value)
        }
    )

    @Test
    fun aRateLimitTheMacMarksFinalStillFailsTheSend() = withTurnHarness(
        answer = { rateLimitedTurn(retryable = false, message = "Daily limit reached", retryAfterSeconds = 5) },
        expectedTurns = 1,
        block = { model, turns, _ ->
            val waits = java.util.concurrent.CopyOnWriteArrayList<Long>()
            model.rateLimitedSendRetryDelay = { waits += it; yield() }
            model.updateDraft("Hello")
            model.send()
            assertEquals("Daily limit reached", withTimeout(5_000) { model.presentedError.first { it != null } })
            withTimeout(5_000) { model.isStarting.first { !it } }
            assertNull(model.pendingSend.value)
            assertTrue(waits.isEmpty())
            assertEquals(1, turns.size)
            assertEquals("the refused text returns to the composer", "Hello", model.draft.value)
        }
    )

    @Test
    fun aForkTheMacRejectedRetriesWithAFreshIdempotencyKey() {
        val fork = forkChat(lineage = AidenChatForkLineage(
            chatId = forkSource.id, messageId = "assistant-1", position = AidenChatForkPosition.AFTER, at = Instant.EPOCH
        ))
        val forkRequests = java.util.concurrent.LinkedBlockingQueue<RecordedRequest>()
        withForkHarness(listOf("chat-fork-v1"), { request ->
            when (request.requestUrl!!.encodedPath) {
                "/api/aiden/v1/chats/${forkSource.id}/fork" -> {
                    forkRequests.add(request)
                    if (forkRequests.size == 1) {
                        MockResponse().setResponseCode(409).setBody(
                            """{"error":{"code":"operation_in_progress","message":"Busy","requestId":"request-busy","retryable":true}}"""
                        )
                    } else {
                        MockResponse().setResponseCode(201).setBody(forkWireJson.encodeToString(AidenChatForkResult(fork)))
                    }
                }
                "/api/aiden/v1/chats/${forkSource.id}" -> MockResponse().setBody(forkWireJson.encodeToString(forkSource))
                else -> null
            }
        }) { harness ->
            val model = harness.open(forkSource.id, forkSource)
            model.fork("assistant-1", AidenChatForkPosition.AFTER)
            withTimeout(5_000) { model.isForking.first { !it } }
            assertEquals("This chat is busy on your Mac. Try forking again in a moment.", model.presentedError.value)
            assertNull(model.forkNavigation.value)

            // Same source revision, same cut: only the key may differ.
            model.fork("assistant-1", AidenChatForkPosition.AFTER)
            assertEquals(fork.id, withTimeout(5_000) { model.forkNavigation.first { it != null } })

            val first = forkRequests.poll()!!
            val second = forkRequests.poll()!!
            assertEquals(first.getHeader("If-Match"), second.getHeader("If-Match"))
            assertNotEquals(
                "The Mac settled the busy key as a rejection, so replaying it can never succeed",
                first.getHeader("Idempotency-Key"), second.getHeader("Idempotency-Key")
            )
        }
    }

    @Test
    fun aForkWhoseResponseWasLostReplaysItsIdempotencyKey() {
        val fork = forkChat(lineage = AidenChatForkLineage(
            chatId = forkSource.id, messageId = "assistant-1", position = AidenChatForkPosition.AFTER, at = Instant.EPOCH
        ))
        val dropResponses = java.util.concurrent.atomic.AtomicBoolean(true)
        val forkKeys = java.util.concurrent.LinkedBlockingQueue<String>()
        withForkHarness(listOf("chat-fork-v1"), { request ->
            when (request.requestUrl!!.encodedPath) {
                "/api/aiden/v1/chats/${forkSource.id}/fork" -> {
                    forkKeys.add(request.getHeader("Idempotency-Key")!!)
                    if (dropResponses.get()) {
                        MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                    } else {
                        MockResponse().setResponseCode(201).setBody(forkWireJson.encodeToString(AidenChatForkResult(fork)))
                    }
                }
                "/api/aiden/v1/chats/${forkSource.id}" -> MockResponse().setBody(forkWireJson.encodeToString(forkSource))
                else -> null
            }
        }) { harness ->
            val model = harness.open(forkSource.id, forkSource)
            model.fork("assistant-1", AidenChatForkPosition.AFTER)
            withTimeout(5_000) { model.isForking.first { !it } }
            assertNull(model.forkNavigation.value)
            assertNotNull("The lost response is reported", model.presentedError.value)

            dropResponses.set(false)
            model.fork("assistant-1", AidenChatForkPosition.AFTER)
            assertEquals(fork.id, withTimeout(5_000) { model.forkNavigation.first { it != null } })

            val keys = forkKeys.toList()
            assertTrue("The retry reached the Mac", keys.size >= 2)
            assertEquals(
                "The Mac may have created the first fork, so the retry replays its key",
                setOf(keys.first()), keys.toSet()
            )
        }
    }

    /** Runs IO normally until [hold]; held work waits for [release]. */
    private class HoldableDispatcher : CoroutineDispatcher() {
        private val executor = Executors.newCachedThreadPool()
        private val held = java.util.concurrent.LinkedBlockingQueue<Runnable>()
        private val firstHeld = CountDownLatch(1)
        @Volatile private var holding = false

        fun hold() {
            holding = true
        }

        fun awaitHeld(timeout: Long, unit: TimeUnit): Boolean = firstHeld.await(timeout, unit)

        @Synchronized
        override fun dispatch(context: kotlin.coroutines.CoroutineContext, block: Runnable) {
            if (holding) {
                held.add(block)
                firstHeld.countDown()
            } else {
                executor.execute(block)
            }
        }

        @Synchronized
        fun release() {
            holding = false
            while (true) executor.execute(held.poll() ?: break)
        }

        fun close() {
            executor.shutdown()
        }
    }

    private val forkWireJson = Json(json) { explicitNulls = false }

    private val forkSource = AidenChat(
        id = "chat-source", workspaceId = "workspace-fork", title = "Parser review",
        messages = listOf(
            AidenChatMessage("user-1", AidenChatRole.USER, "Review the parser.", createdAt = Instant.EPOCH),
            AidenChatMessage("assistant-1", AidenChatRole.ASSISTANT, "Starting.", createdAt = Instant.EPOCH),
            AidenChatMessage("user-2", AidenChatRole.USER, "Use a regex.", createdAt = Instant.EPOCH),
            AidenChatMessage("assistant-2", AidenChatRole.ASSISTANT, "Done.", createdAt = Instant.EPOCH)
        ),
        createdAt = Instant.EPOCH, updatedAt = Instant.EPOCH, revision = "source-r1"
    )

    private fun forkChat(lineage: AidenChatForkLineage) = AidenChat(
        id = "chat-fork", workspaceId = "workspace-fork", title = "Parser review",
        messages = listOf(
            AidenChatMessage("fork-user-1", AidenChatRole.USER, "Review the parser.", createdAt = Instant.EPOCH),
            AidenChatMessage("fork-assistant-1", AidenChatRole.ASSISTANT, "Starting.", createdAt = Instant.EPOCH)
        ),
        createdAt = Instant.EPOCH, updatedAt = Instant.EPOCH, revision = "fork-r1", forkedFrom = lineage
    )

    private class ForkHarness(
        val server: MockWebServer,
        private val requests: java.util.concurrent.ConcurrentLinkedQueue<String>,
        private val coordinator: AidenRemoteCoordinator,
        val cache: AidenChatCache,
        val drafts: AidenChatDraftStore,
        private val viewModels: ViewModelStore
    ) {
        private var opened = 0

        fun paths(): List<String> = requests.toList()

        /** Removes the pairing the way Settings and credential revocation do. */
        fun unpair() = coordinator.removeInstallation(coordinator.installationStore.activeInstallation!!.id)

        suspend fun open(
            chatId: String,
            initial: AidenChat? = null,
            ioDispatcher: CoroutineDispatcher = Dispatchers.IO
        ): AidenChatViewModel {
            val model = AidenChatViewModel(chatId, coordinator, cache, drafts, initial, ioDispatcher = ioDispatcher)
            viewModels.put("fork-${opened++}", model)
            withTimeout(5_000) { model.isLoading.first { !it } }
            withTimeout(5_000) { model.chat.first { it != null } }
            return model
        }
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private fun withForkHarness(
        features: List<String>,
        route: (RecordedRequest) -> MockResponse?,
        block: suspend CoroutineScope.(ForkHarness) -> Unit
    ) {
        val directory = kotlin.io.path.createTempDirectory("aiden-fork-").toFile()
        val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val server = MockWebServer()
        val viewModels = ViewModelStore()
        val scopeJob = Job()
        val paths = java.util.concurrent.ConcurrentLinkedQueue<String>()
        val grants = listOf(AidenRemoteCapability.SERVER_READ, AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.CHAT_WRITE)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                paths.add(request.requestUrl!!.encodedPath)
                return when (request.requestUrl!!.encodedPath) {
                    "/api/aiden/v1/server" -> MockResponse().setBody("""{"protocolVersion":1,"instanceId":"instance-fork","name":"Fork Mac","appVersion":"1.0","capabilities":${json.encodeToString(grants)},"serverCapabilities":${json.encodeToString(grants)},"features":${json.encodeToString(features)},"connectionMode":"lan","serverTime":"2026-10-05T12:00:00Z"}""")
                    "/api/aiden/v1/workspaces" -> MockResponse().setBody("""{"workspaces":[]}""")
                    else -> route(request) ?: MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        Dispatchers.setMain(dispatcher)
        try {
            runBlocking(dispatcher) {
                val installations = AidenInstallationStore(directory, InMemoryAidenSecureStore())
                installations.addInstallation(AidenPairingExchange(
                    instanceId = "instance-fork", deviceId = "device-fork", endpoint = server.url("/api/aiden/v1").toString(),
                    serverSpkiSha256 = "sha256/test", credential = "synthetic", capabilities = grants
                ), null)
                val cache = AidenChatCache(directory)
                val drafts = AidenChatDraftStore(directory)
                val coordinator = AidenRemoteCoordinator(installations, directory, cache, drafts, scope = CoroutineScope(dispatcher + scopeJob))
                coordinator.refreshClient()
                withTimeout(5_000) { coordinator.serverInfo.first { it != null } }
                try {
                    block(ForkHarness(server, paths, coordinator, cache, drafts, viewModels))
                } finally {
                    viewModels.clearAndJoin()
                }
            }
        } finally {
            scopeJob.cancel()
            Dispatchers.resetMain()
            dispatcher.close()
            server.shutdown()
            directory.deleteRecursively()
        }
    }

    @Test
    fun runRegisteredBetweenTheOpeningLookupAndTheFirstRosterIsShownLive() {
        val lookups = java.util.concurrent.atomic.AtomicInteger(0)
        val openingAnswered = CountDownLatch(1)
        withForeignRunChat(initial = foreignRunChat(), agentsRead = true, route = { path, _ ->
            macRunRoute(path) ?: when (path) {
                // The Mac registers its run after answering the opening lookup and
                // before this phone's first roster arrives.
                "/chats/chat-mac/agents" -> {
                    openingAnswered.await(10, TimeUnit.SECONDS)
                    MockResponse().setBody(
                        """{"version":1,"chatId":"chat-mac","turnId":"turn-mac","previousTurns":[],"availability":"ready","epoch":"epoch-run","revision":1,"updatedAt":"2026-10-05T10:00:00Z","agents":[]}"""
                    )
                }
                "/chats/chat-mac/progress/events" -> {
                    openingAnswered.await(10, TimeUnit.SECONDS)
                    runFeed(rosterFrame("turn-mac", 1))
                }
                "/chats/chat-mac/runs/current/events" -> if (lookups.incrementAndGet() == 1) {
                    openingAnswered.countDown()
                    MockResponse().setResponseCode(404)
                } else {
                    macRunFeed
                }
                else -> MockResponse().setResponseCode(404)
            }
        }) { model ->
            withTimeout(5_000) { model.isLoading.first { !it } }
            model.startProgressObservation()
            withTimeout(5_000) { model.liveText.first { it == "Live from the Mac" } }
            assertTrue("A live foreign run offers Stop", model.canStopCurrentRun)
        }
    }

    @Test
    fun turnAnnouncedWhileAnOlderLookupIsOutIsLookedUpWhenItAnswers() {
        val lookups = java.util.concurrent.atomic.AtomicInteger(0)
        val releaseOpening = CountDownLatch(1)
        val attach = AidenForeignRunAttachPolicy(pause = {})
        withForeignRunChat(initial = foreignRunChat(), agentsRead = true, attach = attach, route = { path, _ ->
            macRunRoute(path) ?: when (path) {
                "/chats/chat-mac/agents" -> MockResponse().setBody(
                    """{"version":1,"chatId":"chat-mac","turnId":"turn-1","previousTurns":[],"availability":"ready","epoch":"epoch-run","revision":1,"updatedAt":"2026-10-05T10:00:00Z","agents":[]}"""
                )
                "/chats/chat-mac/progress/events" -> runFeed(rosterFrame("turn-2", 2))
                "/chats/chat-mac/runs/current/events" -> if (lookups.incrementAndGet() == 1) {
                    // The opening lookup was answered before the Mac registered turn-2's run.
                    releaseOpening.await(10, TimeUnit.SECONDS)
                    MockResponse().setResponseCode(404)
                } else {
                    macRunFeed
                }
                else -> MockResponse().setResponseCode(404)
            }
        }) { model ->
            withTimeout(5_000) { model.isLoading.first { !it } }
            model.startProgressObservation()
            withTimeout(5_000) { model.agentRoster.first { it?.turnId == "turn-2" } }
            assertEquals("The opening lookup is still out", 1, lookups.get())
            releaseOpening.countDown()
            withTimeout(5_000) { model.liveText.first { it == "Live from the Mac" } }
        }
    }
}
