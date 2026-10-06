package sbtbiswas.AidenOnTheGo

import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewModelScope
import java.time.Instant
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.features.chat.AidenChatViewModel
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.persistence.AidenChatDraftStore
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.protocol.AidenBotPrivateResponseScope
import sbtbiswas.AidenOnTheGo.protocol.AidenBotPrivateResponseValidator
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException

class AidenTranscriptWindowTest {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val wireJson = Json(json) { explicitNulls = false }

    private fun messages(range: IntRange, prefix: String = "m"): List<AidenChatMessage> = range.map { index ->
        AidenChatMessage(
            "$prefix$index",
            if (index % 2 == 0) AidenChatRole.ASSISTANT else AidenChatRole.USER,
            "Message $index",
            createdAt = Instant.EPOCH
        )
    }

    private fun ids(range: IntRange, prefix: String = "m") = range.map { "$prefix$it" }

    @Test
    fun mergingLatestWindowKeepsEarlierPagesOnlyWhenTheWindowOverlaps() {
        val onScreen = messages(1..8)
        val merged = AidenTranscriptWindowing.mergingLatest(
            AidenChatMessagesWindow("c", "r2", messages(5..9), hasOlder = true), onScreen, currentHasOlder = true
        )
        assertEquals(ids(1..9), merged.messages.map { it.id })
        assertTrue(merged.hasOlder)

        val replaced = AidenTranscriptWindowing.mergingLatest(
            AidenChatMessagesWindow("c", "r3", messages(20..24), hasOlder = true), onScreen, currentHasOlder = false
        )
        assertEquals(ids(20..24), replaced.messages.map { it.id })
        assertTrue(replaced.hasOlder)

        val whole = AidenTranscriptWindowing.mergingLatest(
            AidenChatMessagesWindow("c", "r4", messages(1..3), hasOlder = false), onScreen, currentHasOlder = true
        )
        assertEquals(ids(1..3), whole.messages.map { it.id })
        assertFalse(whole.hasOlder)
    }

    @Test
    fun prependingSkipsDuplicatesAndPagesFromTheOldestServerMessage() {
        val local = AidenChatMessage("local-pending", AidenChatRole.USER, "Draft", createdAt = Instant.EPOCH)
        assertEquals("m4", AidenTranscriptWindowing.earlierCursor(listOf(local) + messages(4..6)))

        val combined = AidenTranscriptWindowing.prepending(
            AidenChatMessagesWindow("c", "r", messages(1..4), hasOlder = false), messages(4..6)
        )
        assertEquals(ids(1..6), combined.messages.map { it.id })
        assertFalse(combined.hasOlder)
    }

    @Test
    fun openingAWindowedChatShowsTheLatestPageAndPagesBackToTheStart() = withWindowedMac(advertisesWindow = true) { mac, model ->
        val opened = withTimeout(5_000) { model.chat.first { it?.revision == "window-r1" } }!!
        assertEquals(ids(71..120), opened.messages.map { it.id })
        assertEquals("Windowed", opened.title)
        assertTrue(model.hasOlderMessages.value)
        assertEquals(0, mac.fullReads.get())
        assertEquals(mapOf("limit" to "50"), mac.windowQueries.first())

        model.loadEarlierMessages()
        withTimeout(5_000) { model.isLoadingEarlierMessages.first { !it } }
        assertEquals(mapOf("limit" to "50", "before" to "m71"), mac.windowQueries.last())
        assertEquals(ids(21..120), model.chat.value!!.messages.map { it.id })
        assertTrue(model.hasOlderMessages.value)

        model.loadEarlierMessages()
        withTimeout(5_000) { model.isLoadingEarlierMessages.first { !it } }
        assertEquals(ids(1..120), model.chat.value!!.messages.map { it.id })
        assertFalse(model.hasOlderMessages.value)

        val requests = mac.windowQueries.size
        model.loadEarlierMessages()
        assertEquals("the start of the chat needs no further page", requests, mac.windowQueries.size)
    }

    @Test
    fun aColdOpenWithNothingCachedReadsTheLatestWindow() =
        withWindowedMac(advertisesWindow = true, seedsChat = false) { mac, model ->
            // Opening a chat the phone has never seen must not fall back to a
            // whole-transcript read: a long chat would exceed the response cap.
            val opened = withTimeout(5_000) { model.chat.first { it?.revision == "window-r1" } }!!
            assertEquals(ids(71..120), opened.messages.map { it.id })
            assertEquals("Windowed", opened.title)
            assertEquals("workspace-window", opened.workspaceId)
            assertTrue(model.hasOlderMessages.value)
            assertEquals(0, mac.fullReads.get())
            assertEquals(mapOf("limit" to "50"), mac.windowQueries.first())
        }

    @Test
    fun refreshingAWindowedChatKeepsEarlierPagesAndAppendsNewMessages() = withWindowedMac(advertisesWindow = true) { mac, model ->
        withTimeout(5_000) { model.chat.first { it?.revision == "window-r1" } }
        model.loadEarlierMessages()
        withTimeout(5_000) { model.isLoadingEarlierMessages.first { !it } }
        assertEquals(100, model.chat.value!!.messages.size)

        mac.transcript.set(messages(1..121) to "window-r2")
        model.loadChat()
        val refreshed = withTimeout(5_000) { model.chat.first { it?.revision == "window-r2" } }!!
        assertEquals(ids(21..121), refreshed.messages.map { it.id })
        assertTrue(model.hasOlderMessages.value)
    }

    @Test
    fun revisionConflictWhilePagingReloadsTheLatestWindow() = withWindowedMac(advertisesWindow = true) { mac, model ->
        withTimeout(5_000) { model.chat.first { it?.revision == "window-r1" } }
        model.loadEarlierMessages()
        withTimeout(5_000) { model.isLoadingEarlierMessages.first { !it } }
        assertEquals("m21", model.chat.value!!.messages.first().id)

        // The Mac rewrote the chat, so the phone's oldest message is gone.
        mac.transcript.set(messages(1..80, prefix = "n") to "window-r9")
        model.loadEarlierMessages()
        withTimeout(5_000) { model.isLoadingEarlierMessages.first { !it } }

        assertEquals(ids(31..80, prefix = "n"), model.chat.value!!.messages.map { it.id })
        assertEquals("window-r9", model.chat.value!!.revision)
        assertTrue(model.hasOlderMessages.value)
        assertNull("a conflict recovers without an error", model.presentedError.value)
        assertEquals(mapOf("limit" to "50"), mac.windowQueries.last())

        model.loadEarlierMessages()
        withTimeout(5_000) { model.isLoadingEarlierMessages.first { !it } }
        assertEquals(ids(1..80, prefix = "n"), model.chat.value!!.messages.map { it.id })
        assertFalse(model.hasOlderMessages.value)
    }

    @Test
    fun windowMetadataDecodesAsTheChatAndFailsClosedWhenPartial() {
        val page = """{"chatId":"c","revision":"r","messages":[],"hasOlder":true,"workspaceId":"w","title":"Named",""" +
            """"providerId":"p","modelId":"m","createdAt":"2026-09-27T12:00:00Z","updatedAt":"2026-09-27T13:00:00Z"}"""
        val chat = json.decodeFromString<AidenChatMessagesWindow>(page).chat()!!
        assertEquals("Named", chat.title)
        assertEquals("m", chat.modelId)
        assertEquals(Instant.parse("2026-09-27T13:00:00Z"), chat.updatedAt)
        assertEquals("r", chat.revision)
        assertNull(chat.forkedFrom)

        // A fork's page carries its lineage, so a windowed refresh keeps the lineage row.
        val forked = json.decodeFromString<AidenChatMessagesWindow>(
            page.replace(""""title":"Named",""", """"title":"Named","forkedFrom":{"chatId":"chat-source","messageId":"message-2","position":"after","at":"2026-09-27T11:00:00Z"},""")
        ).chat()!!
        assertEquals("chat-source", forked.forkedFrom?.chatId)
        assertEquals("message-2", forked.forkedFrom?.messageId)

        assertNull(
            json.decodeFromString<AidenChatMessagesWindow>("""{"chatId":"c","revision":"r","messages":[],"hasOlder":false}""").chat()
        )
        val partial = listOf(
            page.replace(""""workspaceId":"w",""", ""),
            page.replace(""""modelId":"m",""", ""),
            page.replace("2026-09-27T13:00:00Z", "2026-09-27T11:00:00Z"),
            page.replace(""""title":"Named",""", """"title":"Named","titlePending":false,""")
        )
        for (invalid in partial) {
            assertThrows(invalid, Exception::class.java) { json.decodeFromString<AidenChatMessagesWindow>(invalid) }
        }

        // A Bot window keeps a Bot chat's privacy: reasoning is refused there,
        // as it is on a whole Bot chat read, but stays readable on a regular one.
        val reasoning = """{"chatId":"c","revision":"r","hasOlder":false,"workspaceId":"w","title":"t",""" +
            """"createdAt":"2026-09-27T12:00:00Z","updatedAt":"2026-09-27T12:00:00Z",""" +
            """"messages":[{"id":"a","role":"assistant","content":"x","reasoning":"thought"}]}"""
        AidenBotPrivateResponseValidator.validate(reasoning, AidenBotPrivateResponseScope.MessagesWindowProjection)
        assertThrows(AidenRemoteContractException.UnsafePayloadField::class.java) {
            AidenBotPrivateResponseValidator.validate(
                reasoning.replace(""""workspaceId":"w",""", """"workspaceId":"w","botId":"bot-1","""),
                AidenBotPrivateResponseScope.MessagesWindowProjection
            )
        }
    }

    @Test
    fun refreshingAWindowedChatAdoptsADesktopRenameAndModelChange() = withWindowedMac(advertisesWindow = true) { mac, model ->
        withTimeout(5_000) { model.chat.first { it?.revision == "window-r1" } }
        model.loadEarlierMessages()
        withTimeout(5_000) { model.isLoadingEarlierMessages.first { !it } }
        assertNull(model.chat.value!!.modelId)

        mac.changeMetadata("Renamed on the Mac", "provider-2", "model-2", Instant.parse("2026-09-27T13:00:00Z"), "window-r2")
        model.loadChat()
        val refreshed = withTimeout(5_000) { model.chat.first { it?.revision == "window-r2" } }!!

        assertEquals("Renamed on the Mac", refreshed.title)
        assertEquals("provider-2", refreshed.providerId)
        assertEquals("model-2", refreshed.modelId)
        assertEquals(Instant.parse("2026-09-27T13:00:00Z"), refreshed.updatedAt)
        assertEquals("loaded pages survive the refresh", ids(21..120), refreshed.messages.map { it.id })
        assertEquals("the newest page alone carries the metadata", 0, mac.fullReads.get())
    }

    @Test
    fun aWindowWithoutMetadataKeepsTheWholeChatRead() =
        withWindowedMac(advertisesWindow = true, advertisesMetadata = false) { mac, model ->
            // A revision-19 to 22 Mac pages messages but cannot say the chat's
            // title or model, so the phone keeps reading whole chats from it.
            val opened = withTimeout(5_000) { model.chat.first { it?.revision == "window-r1" } }!!
            assertEquals(ids(1..120), opened.messages.map { it.id })
            assertFalse(model.hasOlderMessages.value)

            mac.changeMetadata("Renamed on the Mac", "provider-2", "model-2", Instant.parse("2026-09-27T13:00:00Z"), "window-r2")
            model.loadChat()
            val refreshed = withTimeout(5_000) { model.chat.first { it?.revision == "window-r2" } }!!
            assertEquals("Renamed on the Mac", refreshed.title)
            assertEquals("model-2", refreshed.modelId)
            assertEquals(2, mac.fullReads.get())
            assertTrue(mac.windowQueries.isEmpty())
        }

    @Test
    fun anEarlierPageLoadedWhileARefreshIsInFlightIsKept() = withWindowedMac(advertisesWindow = true) { mac, model ->
        withTimeout(5_000) { model.chat.first { it?.revision == "window-r1" } }
        assertEquals("m71", model.chat.value!!.messages.first().id)

        // A refresh asks for the newest page; while its answer is in flight the
        // reader loads the page before the one on screen.
        mac.transcript.set(messages(1..121) to "window-r2")
        val hold = CountDownLatch(1)
        mac.holdNewestPage.set(hold)
        model.loadChat()
        assertTrue(withContext(Dispatchers.IO) { mac.newestPageHeld.await(5, TimeUnit.SECONDS) })
        model.loadEarlierMessages()
        withTimeout(5_000) { model.isLoadingEarlierMessages.first { !it } }
        assertEquals("m21", model.chat.value!!.messages.first().id)

        hold.countDown()
        val refreshed = withTimeout(5_000) { model.chat.first { it?.revision == "window-r2" } }!!
        assertEquals(ids(21..121), refreshed.messages.map { it.id })
        assertTrue(model.hasOlderMessages.value)
    }

    @Test
    fun aMacWithoutTheWindowFeatureServesTheWholeTranscript() = withWindowedMac(advertisesWindow = false) { mac, model ->
        val opened = withTimeout(5_000) { model.chat.first { it?.revision == "window-r1" } }!!
        assertEquals(ids(1..120), opened.messages.map { it.id })
        assertFalse(model.hasOlderMessages.value)
        assertEquals(1, mac.fullReads.get())

        model.loadEarlierMessages()
        assertFalse(model.isLoadingEarlierMessages.value)
        assertTrue("an older Mac is never asked for message pages", mac.windowQueries.isEmpty())
    }

    private class WindowedMac {
        val transcript = AtomicReference<Pair<List<AidenChatMessage>, String>>()
        val windowQueries = ConcurrentLinkedQueue<Map<String, String>>()
        val fullReads = AtomicInteger(0)
        val advertises = AtomicBoolean(true)
        val title = AtomicReference("Windowed")
        val selection = AtomicReference<Pair<String, String>?>(null)
        val updatedAt = AtomicReference(Instant.EPOCH)
        /** When set, the next newest-page request waits for this latch. */
        val holdNewestPage = AtomicReference<CountDownLatch?>(null)
        val newestPageHeld = CountDownLatch(1)

        /** The desktop renames the chat and picks another model; the messages stay. */
        fun changeMetadata(title: String, providerId: String, modelId: String, updatedAt: Instant, revision: String) {
            this.title.set(title)
            selection.set(providerId to modelId)
            this.updatedAt.set(updatedAt)
            transcript.set(transcript.get().first to revision)
        }
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private fun withWindowedMac(
        advertisesWindow: Boolean,
        advertisesMetadata: Boolean = true,
        seedsChat: Boolean = true,
        body: suspend (WindowedMac, AidenChatViewModel) -> Unit
    ) {
        val directory = kotlin.io.path.createTempDirectory("aiden-window-").toFile()
        val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val server = MockWebServer()
        val viewModels = ViewModelStore()
        val scopeJob = Job()
        val mac = WindowedMac()
        mac.transcript.set(messages(1..120) to "window-r1")
        mac.advertises.set(advertisesWindow)
        val initial = AidenChat(
            id = "chat-window", workspaceId = "workspace-window", title = "Windowed",
            messages = emptyList(), createdAt = Instant.EPOCH, updatedAt = Instant.EPOCH, revision = "window-r0"
        )
        val grants = listOf(AidenRemoteCapability.SERVER_READ, AidenRemoteCapability.CHAT_READ)
        val features = when {
            !advertisesWindow -> "[]"
            advertisesMetadata -> """["chat-messages-window-v1","chat-messages-window-metadata-v1"]"""
            else -> """["chat-messages-window-v1"]"""
        }
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl!!.encodedPath) {
                "/api/aiden/v1/server" -> MockResponse().setBody("""{"protocolVersion":1,"instanceId":"instance-window","name":"Window Mac","appVersion":"1.0","capabilities":${json.encodeToString(grants)},"serverCapabilities":${json.encodeToString(grants)},"features":$features,"connectionMode":"lan","serverTime":"2026-09-27T12:00:00Z"}""")
                "/api/aiden/v1/workspaces" -> MockResponse().setBody("""{"workspaces":[]}""")
                "/api/aiden/v1/chats/chat-window" -> {
                    mac.fullReads.incrementAndGet()
                    val (all, revision) = mac.transcript.get()
                    MockResponse().setBody(wireJson.encodeToString(initial.copy(
                        title = mac.title.get(), providerId = mac.selection.get()?.first, modelId = mac.selection.get()?.second,
                        updatedAt = mac.updatedAt.get(), messages = all, revision = revision
                    )))
                }
                "/api/aiden/v1/chats/chat-window/messages" -> if (!mac.advertises.get()) {
                    MockResponse().setResponseCode(404)
                } else {
                    val url = request.requestUrl!!
                    mac.windowQueries.add(url.queryParameterNames.associateWith { url.queryParameter(it).orEmpty() })
                    val (all, revision) = mac.transcript.get()
                    val limit = url.queryParameter("limit")?.toIntOrNull() ?: 50
                    val before = url.queryParameter("before")
                    if (before == null) mac.holdNewestPage.getAndSet(null)?.let { hold ->
                        mac.newestPageHeld.countDown()
                        hold.await(5, TimeUnit.SECONDS)
                    }
                    val end = if (before == null) all.size else all.indexOfFirst { it.id == before }
                    if (end < 0) {
                        MockResponse().setResponseCode(409).setBody(
                            """{"error":{"code":"revision_conflict","message":"The transcript changed.","requestId":"window","retryable":false}}"""
                        )
                    } else {
                        val start = maxOf(0, end - limit)
                        val page = AidenChatMessagesWindow("chat-window", revision, all.subList(start, end), start > 0)
                        MockResponse().setBody(wireJson.encodeToString(if (!advertisesMetadata) page else page.copy(
                            workspaceId = initial.workspaceId, title = mac.title.get(),
                            providerId = mac.selection.get()?.first, modelId = mac.selection.get()?.second,
                            createdAt = initial.createdAt, updatedAt = mac.updatedAt.get()
                        )))
                    }
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
                    instanceId = "instance-window", deviceId = "device-window", endpoint = server.url("/api/aiden/v1").toString(),
                    serverSpkiSha256 = "sha256/test", credential = "synthetic", capabilities = grants
                ), null)
                val cache = AidenChatCache(directory)
                val drafts = AidenChatDraftStore(directory)
                val coordinator = AidenRemoteCoordinator(installations, directory, cache, drafts, scope = CoroutineScope(dispatcher + scopeJob))
                coordinator.refreshClient()
                withTimeout(5_000) { coordinator.serverInfo.first { it != null } }
                val model = AidenChatViewModel(initial.id, coordinator, cache, drafts, initial.takeIf { seedsChat })
                viewModels.put("window", model)
                try {
                    body(mac, model)
                } finally {
                    withContext(NonCancellable) {
                        val job = model.viewModelScope.coroutineContext[Job]
                        viewModels.clear()
                        job?.join()
                    }
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
}
