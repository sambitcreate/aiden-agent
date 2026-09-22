package sbtbiswas.AidenOnTheGo

import androidx.lifecycle.ViewModelStore
import java.io.File
import java.time.Instant
import java.util.Base64
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.features.chat.AidenChatViewModel
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.persistence.AidenChatDraftStore
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability

class AidenChatTest {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    @Test
    fun sharedRunInputReceiptsRequireExactIdentityAndAdmission() {
        val fixture = javaClass.classLoader!!.getResourceAsStream("contract.json")!!.bufferedReader().use { it.readText() }
        val input = json.parseToJsonElement(fixture).jsonObject.getValue("chatRunInput").jsonObject
        val request = json.decodeFromString<AidenRunInputRequest>(input.getValue("request").toString())
        for (key in listOf("accepted", "rejected")) {
            val receipt = json.decodeFromString<AidenRunInputReceipt>(input.getValue(key).toString())
            assertTrue(receipt.validates(request, "stream-input-1"))
            assertFalse(receipt.validates(request, "other-stream"))
            assertFalse(receipt.copy(requestId = UUID.randomUUID().toString()).validates(request, "stream-input-1"))
            assertFalse(receipt.copy(mode = AidenRunInputMode.QUEUE).validates(request, "stream-input-1"))
        }
        val accepted = json.decodeFromString<AidenRunInputReceipt>(input.getValue("accepted").toString())
        assertFalse(accepted.copy(admission = "consumed").validates(request, "stream-input-1"))
        assertFalse(accepted.copy(messageId = "m".repeat(129)).validates(request, "stream-input-1"))
    }

    @Test
    fun unconfirmedRunInputMarkerSurvivesEmptyDraftAndPurgesWithInstallation() {
        val root = kotlin.io.path.createTempDirectory("run-input-marker-").toFile()
        try {
            val store = AidenChatDraftStore(root = root)
            val session = store.beginSession("mac", "bot")
            assertTrue(store.setUnconfirmedRunInput(true, session))
            assertTrue(store.save("", session))
            val reopened = AidenChatDraftStore(root = root)
            val next = reopened.beginSession("mac", "bot")
            assertTrue(reopened.hasUnconfirmedRunInput(next))
            reopened.purge("mac")
            assertFalse(reopened.setUnconfirmedRunInput(true, next))
            assertFalse(reopened.hasUnconfirmedRunInput(reopened.beginSession("mac", "bot")))
        } finally { root.deleteRecursively() }
    }

    @Test
    fun failedSendRestoresDurableDraftAfterRestart() = assertFailedSendDraft()

    @Test
    fun failedSendPersistsSubmittedTextAndNewerEdits() = assertFailedSendDraft(newerText = "Newer unsent text")

    @Test
    fun failedSendCannotRestoreDraftAfterInstallationPurge() = assertFailedSendDraft(purgeWhileSending = true)

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private fun assertFailedSendDraft(newerText: String = "", purgeWhileSending: Boolean = false) {
        val directory = kotlin.io.path.createTempDirectory("aiden-failed-send-").toFile()
        val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val turnArrived = CountDownLatch(1)
        val releaseTurn = CountDownLatch(1)
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
                    turnArrived.countDown()
                    check(releaseTurn.await(5, TimeUnit.SECONDS)) { "Send response was not released" }
                    MockResponse().setResponseCode(503).setBody("""{"error":{"code":"internal_error","message":"Try again","requestId":"request-draft","retryable":true}}""")
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
                model.send()
                withContext(Dispatchers.IO) { assertTrue(turnArrived.await(5, TimeUnit.SECONDS)) }
                assertTrue(model.isStarting.value)
                assertEquals("", model.draft.value)
                // Sending intentionally clears persistence until a response is known.
                assertNull(AidenChatDraftStore(directory).getDraft(installation.instanceId, initialChat.id))
                if (newerText.isNotEmpty()) model.updateDraft(newerText)
                if (purgeWhileSending) coordinator.removeInstallation(installation.id)
                releaseTurn.countDown()
                withTimeout(5_000) { model.isStarting.first { !it } }
                val expected = if (newerText.isEmpty()) "Original unsent text" else "Original unsent text\n\n$newerText"
                assertEquals(expected, model.draft.value)
                assertEquals("Try again", model.presentedError.value)
                assertTrue(model.chat.value!!.messages.isEmpty())
                viewModels.clear()
                // A fresh store is the process-restart read path, not the ViewModel's memory.
                val reopened = AidenChatDraftStore(directory)
                assertEquals(
                    if (purgeWhileSending) null else expected,
                    reopened.getDraft(installation.instanceId, initialChat.id)
                )
            }
        } finally {
            releaseTurn.countDown()
            runBlocking(dispatcher) { viewModels.clear() }
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
    fun mismatchedStopAcknowledgementShowsFailure() = exerciseRunControl("stop-mismatch")

    @Test
    fun runInputWaitsForReceiptAndSendsOnce() = exerciseRunControl("input-accepted")

    @Test
    fun runInputPreservesEditBeforeDispatch() = exerciseRunControl("input-early-edit")

    @Test
    fun failedDraftDeletionKeepsUnconfirmedGate() = exerciseRunControl("input-delete-failed")

    @Test
    fun runInputPreservesNewerDraft() = exerciseRunControl("input-newer")

    @Test
    fun runInputDisconnectPersistsUnconfirmedMarkerWithoutRetry() = exerciseRunControl("input-unknown")

    @Test
    fun rejectedRunInputKeepsDraftWithoutFallingBackToSend() = exerciseRunControl("input-rejected")

    @Test
    fun runInputRequiresAdvertisedFeature() = exerciseRunControl("input-unsupported")

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private fun exerciseRunControl(scenario: String) {
        val directory = kotlin.io.path.createTempDirectory("aiden-control-").toFile()
        val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val arrived = CountDownLatch(1)
        val release = CountDownLatch(1)
        val finishRead = CountDownLatch(1)
        val terminal = java.util.concurrent.atomic.AtomicBoolean(false)
        val writes = java.util.concurrent.atomic.AtomicInteger()
        val snapshotId = java.util.concurrent.atomic.AtomicReference("approval-current")
        val server = MockWebServer()
        val viewModels = ViewModelStore()
        val grants = listOf(AidenRemoteCapability.SERVER_READ, AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.CHAT_WRITE) +
            if (scenario == "unsupported") emptyList() else listOf(AidenRemoteCapability.APPROVAL_RESPOND) +
                if (scenario.startsWith("input")) listOf(AidenRemoteCapability.BOT_READ, AidenRemoteCapability.BOT_WRITE) else emptyList()
        val chat = AidenChat(id = "chat-control", workspaceId = "workspace-control", title = "Controls",
            botId = if (scenario == "bot-denied" || scenario.startsWith("input")) "bot-control" else null, messages = emptyList(), createdAt = Instant.EPOCH, updatedAt = Instant.EPOCH, revision = "revision-control")
        val status = """{"streamId":"stream-control","chatId":"chat-control","turnId":"turn-control","state":"${if (scenario.startsWith("input")) "running" else "waiting_for_approval"}","lastSequence":0,"updatedAt":"2026-09-22T12:00:00Z"}"""
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path == "/api/aiden/v1/server" -> MockResponse().setBody("""{"protocolVersion":1,"instanceId":"instance-control","name":"Control Mac","appVersion":"1.0","capabilities":${json.encodeToString(grants)},"serverCapabilities":${json.encodeToString(grants)},"features":${if (scenario.startsWith("input") && scenario != "input-unsupported") "[\"chat-run-input-v1\"]" else "[]"},"connectionMode":"lan","serverTime":"2026-09-22T12:00:00Z"}""")
                request.path == "/api/aiden/v1/workspaces" -> MockResponse().setBody("""{"workspaces":[]}""")
                request.path == "/api/aiden/v1/chats/chat-control" -> {
                    if (terminal.get()) check(finishRead.await(10, TimeUnit.SECONDS))
                    MockResponse().setBody(json.encodeToString(chat))
                }
                request.path == "/api/aiden/v1/streams/stream-control/events" -> MockResponse().setHeader("Content-Type", "text/event-stream").setBody(if (terminal.get()) "id: 1\nevent: done\ndata: {\"protocolVersion\":1,\"streamId\":\"stream-control\",\"sequence\":1,\"timestamp\":\"2026-09-22T12:00:00Z\",\"type\":\"done\",\"terminal\":true,\"payload\":{\"messageId\":\"message-control\"}}\n\n" else "")
                request.path == "/api/aiden/v1/streams/stream-control" -> MockResponse().setBody(status)
                request.path == "/api/aiden/v1/streams/stream-control/approval" -> MockResponse().setBody("""{"approval":{"approvalId":"${snapshotId.get()}","streamId":"stream-control","chatId":"chat-control","summary":"Review current action","toolCallId":"tool-control","toolName":"read_file","expiresAt":"2099-01-01T00:00:00Z","canAllow":true}}""")
                request.method == "POST" -> {
                    writes.incrementAndGet()
                    arrived.countDown()
                    check(release.await(10, TimeUnit.SECONDS))
                    if (scenario.startsWith("input")) {
                        val input = json.decodeFromString<AidenRunInputRequest>(request.body.readUtf8())
                        assertEquals("/api/aiden/v1/streams/stream-control/inputs", request.path)
                        assertEquals(input.requestId, request.getHeader("Idempotency-Key"))
                        assertEquals("Original instruction", input.text)
                        if (scenario == "input-unknown") return MockResponse().setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.DISCONNECT_AFTER_REQUEST)
                        return MockResponse().setBody(Json { explicitNulls = false }.encodeToString(AidenRunInputReceipt(
                            input.requestId, "stream-control", input.mode, scenario != "input-rejected",
                            admission = if (scenario == "input-rejected") null else "queued",
                            messageId = if (scenario == "input-rejected") null else "message-input",
                            reason = if (scenario == "input-rejected") "not-active" else null)))
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
                if (scenario.startsWith("input")) {
                    withTimeout(5_000) { model.streamState.first { it == AidenStreamState.RUNNING } }
                    model.updateDraft("Original instruction")
                    model.submitRunInput(AidenRunInputMode.STEER, "stale-stream")
                    assertEquals(0, writes.get())
                    if (scenario == "input-unsupported") {
                        assertFalse(model.supportsRunInput)
                        model.submitRunInput(AidenRunInputMode.STEER, "stream-control")
                        yield()
                        assertEquals(0, writes.get())
                        return@runBlocking
                    }
                    model.updateDraft("🦊".repeat(5000))
                    assertFalse(model.canSubmitRunInput)
                    model.updateDraft("Original instruction")
                    assertTrue(model.canSubmitRunInput)
                    model.submitRunInput(AidenRunInputMode.STEER, "stream-control")
                    if (scenario == "input-early-edit") model.updateDraft("Newer instruction")
                    model.submitRunInput(AidenRunInputMode.QUEUE, "stream-control")
                    withContext(Dispatchers.IO) { assertTrue(arrived.await(5, TimeUnit.SECONDS)) }
                    assertEquals(if (scenario == "input-early-edit") "Newer instruction" else "Original instruction", model.draft.value)
                    if (scenario == "input-newer") model.updateDraft("Newer instruction")
                    if (scenario == "input-delete-failed") {
                        val draftFile = drafts.root.walkTopDown().first { it.isFile && it.extension == "json" }
                        check(draftFile.delete())
                        check(draftFile.mkdir())
                        File(draftFile, "undeletable-child").writeText("fixture")
                    }
                    release.countDown()
                    withTimeout(5_000) { model.isSubmittingRunInput.first { !it } }
                    assertEquals(1, writes.get())
                    assertEquals(when (scenario) {
                        "input-accepted" -> ""
                        "input-newer", "input-early-edit" -> "Newer instruction"
                        else -> "Original instruction"
                    }, model.draft.value)
                    assertEquals(scenario in listOf("input-unknown", "input-delete-failed"), model.hasUnconfirmedRunInput.value)
                    assertFalse(model.canSend)
                    // A fresh store represents process restart; unknown outcomes remain gated.
                    val reopened = AidenChatDraftStore(directory)
                    val reopenedSession = reopened.beginSession("instance-control", chat.id)
                    assertEquals(scenario in listOf("input-unknown", "input-delete-failed"), reopened.hasUnconfirmedRunInput(reopenedSession))
                    if (scenario == "input-early-edit") assertEquals("Newer instruction", reopened.load(reopenedSession))
                    if (scenario == "input-unknown") {
                        model.submitRunInput(AidenRunInputMode.STEER, "stream-control")
                        assertEquals(1, writes.get())
                        model.acknowledgeUnconfirmedRunInput()
                        assertFalse(model.hasUnconfirmedRunInput.value)
                    }
                    return@runBlocking
                }
                withTimeout(5_000) { model.pendingApproval.first { it?.id == "approval-current" } }
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
                if (scenario == "revoked") coordinator.removeInstallation(installation.id)
                if (scenario.endsWith("terminal")) {
                    terminal.set(true)
                    withTimeout(5_000) { model.streamState.first { it?.isTerminal == true } }
                }
                release.countDown()
                if (scenario.startsWith("stop")) {
                    withTimeout(5_000) { model.isStopping.first { !it } }
                    if (scenario.endsWith("terminal")) assertTrue(model.streamState.value!!.isTerminal)
                    else {
                        assertTrue(model.presentedError.value!!.contains("Stop was not confirmed"))
                        assertFalse(model.streamState.value!!.isTerminal)
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
            release.countDown()
            finishRead.countDown()
            runBlocking(dispatcher) { viewModels.clear(); scopeJob.cancel() }
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
            "1 web search, 1 Mac action, compacted context, 1 tool call",
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
        assertEquals("Create this automation?", AidenApprovalPresentation.title(approval.toolName))
        assertEquals("Create a daily report", AidenApprovalPresentation.oneLineSummary(approval.summary))
        assertTrue(AidenApprovalPresentation.requiresMacConfirmation(approval))
        assertFalse(AidenApprovalPresentation.requiresMacConfirmation(approval.copy(hostCanAllow = true, canAllow = true)))
        assertEquals("Approval Required", AidenApprovalPresentation.title("run_command"))
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
        assertFalse(AidenApprovalPresentation.requiresMacConfirmation(readOnlySchedule))

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
            "browser_recording_stop" to "Stopped browser recording"
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
    fun compactionMetricsUseExistingActivityDetail() {
        val step = AidenAgentStep(
            id = "compact-1", order = 0, kind = AidenAgentStep.Kind.TOOL,
            toolName = "compact_context", label = "Compact context",
            status = AidenAgentStepStatus.COMPLETED, startedAt = 1000.0,
            updatedAt = 2000.0, finishedAt = 2000.0, contentOffset = 0,
            durationMs = 1000.0, detail = "pi-vcc · 0.4s · ~25900 → 6758 tokens"
        )
        assertEquals("Compacted context pi-vcc · 0.4s · ~25900 → 6758 tokens", AidenAgentActivityPresentation.line(step))
        assertEquals(step.detail, json.decodeFromString<AidenAgentStep>(json.encodeToString(step)).detail)
    }
}
