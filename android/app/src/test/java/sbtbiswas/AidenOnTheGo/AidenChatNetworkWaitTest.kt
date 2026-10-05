package sbtbiswas.AidenOnTheGo

import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewModelScope
import java.time.Instant
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
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
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.features.chat.AidenChatViewModel
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenNetworkAvailability
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.persistence.AidenChatDraftStore
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability

class AidenChatNetworkWaitTest {
    private class FakeNetwork(initial: Boolean) : AidenNetworkAvailability {
        val state = MutableStateFlow(initial)
        override val isAvailable: StateFlow<Boolean> = state
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun streamLostOfflineWaitsForNetworkWithoutProbingThenResumesOnceFromLastSequence() {
        val directory = kotlin.io.path.createTempDirectory("aiden-network-wait-").toFile()
        val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val server = MockWebServer()
        val viewModels = ViewModelStore()
        val eventPaths = java.util.Collections.synchronizedList(mutableListOf<String>())
        val statusReads = AtomicInteger()
        val chatReads = AtomicInteger()
        val network = FakeNetwork(initial = false)
        val initial = AidenChat(
            id = "chat-network", workspaceId = "workspace-network", title = "Network",
            messages = emptyList(), createdAt = Instant.EPOCH, updatedAt = Instant.EPOCH, revision = "r1"
        )
        val final = initial.copy(messages = listOf(AidenChatMessage(
            id = "final-reply", role = AidenChatRole.ASSISTANT, text = "prefix suffix", createdAt = Instant.EPOCH
        )))
        val wireJson = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }
        fun event(sequence: Int, type: String, payload: String, terminal: Boolean = false) =
            "id: $sequence\nevent: $type\ndata: {\"protocolVersion\":1,\"streamId\":\"stream-network\",\"sequence\":$sequence,\"timestamp\":\"2026-10-04T00:00:00Z\",\"type\":\"$type\",\"terminal\":$terminal,\"payload\":$payload}\n\n"
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                return when {
                    path.endsWith("/events") -> {
                        eventPaths.add(request.path!!)
                        when (eventPaths.size) {
                            // The first connection drops after sequence 1, while
                            // the device is offline.
                            1 -> MockResponse().setHeader("Content-Type", "text/event-stream")
                                .setBody(event(1, "text_delta", "{\"text\":\"prefix \"}"))
                            else -> MockResponse().setHeader("Content-Type", "text/event-stream").setBody(
                                event(2, "text_delta", "{\"text\":\"suffix\"}") +
                                    event(3, "done", "{\"messageId\":\"final-reply\"}", true)
                            )
                        }
                    }
                    path.endsWith("/streams/stream-network") -> {
                        statusReads.incrementAndGet()
                        MockResponse().setBody(
                            """{"streamId":"stream-network","chatId":"chat-network","turnId":"turn-network","state":"running","lastSequence":1}"""
                        )
                    }
                    path.endsWith("/chats/chat-network") ->
                        MockResponse().setBody(wireJson.encodeToString(if (chatReads.incrementAndGet() == 1) initial else final))
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        Dispatchers.setMain(dispatcher)
        try {
            runBlocking(dispatcher) {
                val installations = AidenInstallationStore(directory, InMemoryAidenSecureStore())
                installations.addInstallation(AidenPairingExchange(
                    instanceId = "instance-network", deviceId = "device-network",
                    endpoint = server.url("/api/aiden/v1").toString(), serverSpkiSha256 = "sha256/test",
                    credential = "synthetic", capabilities = listOf(AidenRemoteCapability.CHAT_READ)
                ), null)
                val cache = AidenChatCache(directory)
                cache.saveChat(initial, "instance-network")
                val drafts = AidenChatDraftStore(directory)
                val coordinator = AidenRemoteCoordinator(installations, directory, cache, drafts,
                    scope = CoroutineScope(dispatcher + Job().apply { cancel() }))
                coordinator.refreshClient()
                cache.saveActiveStream(
                    AidenChatCache.ActiveStream("device-network", "stream-network", "turn-network", 0),
                    "instance-network", initial.id
                )
                val model = AidenChatViewModel(initial.id, coordinator, cache, drafts, initial, networkAvailability = network)
                viewModels.put("chat", model)

                withTimeout(8_000) { model.isWaitingForNetwork.first { it } }
                withTimeout(2_000) { model.liveText.first { it == "prefix " } }
                assertTrue(model.hasActiveStream.value)
                assertNull("losing the network is not an error", model.presentedError.value)
                val statusReadsWhenParked = statusReads.get()
                delay(300)
                assertEquals("no status probe is spent while offline", statusReadsWhenParked, statusReads.get())
                assertEquals("no reconnect is attempted while offline", 1, eventPaths.size)
                assertNull(model.presentedError.value)

                // A flapping return wakes the one parked consumer exactly once.
                network.state.value = true
                network.state.value = false
                network.state.value = true
                withTimeout(8_000) { model.streamState.first { it == AidenStreamState.DONE } }
                withTimeout(5_000) { model.hasActiveStream.first { !it } }
                assertFalse(model.isWaitingForNetwork.value)
                assertNull(model.presentedError.value)
                assertEquals("final-reply", model.chat.value!!.messages.last().id)
                val paths = synchronized(eventPaths) { eventPaths.toList() }
                assertEquals("one reconnect after the network returned: $paths", 2, paths.size)
                assertTrue("resumed after the last applied sequence: $paths", paths[1].endsWith("after=1"))
            }
        } finally {
            runBlocking(dispatcher) {
                withContext(NonCancellable) {
                    val jobs = viewModels.keys().mapNotNull { viewModels.get(it)?.viewModelScope?.coroutineContext?.get(Job) }
                    viewModels.clear()
                    jobs.forEach { it.join() }
                }
            }
            Dispatchers.resetMain()
            dispatcher.close()
            server.shutdown()
            directory.deleteRecursively()
        }
    }
}
