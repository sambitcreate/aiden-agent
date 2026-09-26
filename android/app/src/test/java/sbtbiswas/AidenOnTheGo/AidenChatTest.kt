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
import kotlinx.coroutines.async
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
                model.updateDraft("Next turn")
                assertEquals(holdInitialLoad, model.canSend)
                assertTrue(requests.none { it.endsWith("/turns") })
            }
        } finally {
            releaseInitialLoad.countDown()
            runBlocking(dispatcher) { viewModels.clear() }
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
                    } finally { release.countDown(); getRelease.countDown(); owners.clear(); server.shutdown(); root.deleteRecursively() }
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
    fun formFillActivityDecodesCountOnlyOutcome() {
        val step = json.decodeFromString<AidenAgentStep>("""{"id":"tool-1","order":0,"kind":"tool","toolCallId":"call-1","toolName":"form_fill","label":"Form fill","status":"completed","startedAt":1000,"updatedAt":2000,"finishedAt":2000,"contentOffset":0,"detail":"1 filled · 1 not attempted · stopped early"}""")
        assertEquals("Form fill 1 filled · 1 not attempted · stopped early", AidenAgentActivityPresentation.line(step))
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
        assertTrue(AidenApprovalPresentation.requiresDesktopConfirmation(approval))
        assertFalse(AidenApprovalPresentation.requiresDesktopConfirmation(approval.copy(hostCanAllow = true, canAllow = true)))
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
                    } finally { viewModels.clear(); root.deleteRecursively() }
                }
            }
        } finally { Dispatchers.resetMain(); dispatcher.close() }
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
}
