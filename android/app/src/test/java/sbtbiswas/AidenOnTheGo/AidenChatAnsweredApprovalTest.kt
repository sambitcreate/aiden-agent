package sbtbiswas.AidenOnTheGo

import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewModelScope
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancelAndJoin
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.features.chat.AidenChatViewModel
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.AidenApprovalDecision
import sbtbiswas.AidenOnTheGo.models.AidenChat
import sbtbiswas.AidenOnTheGo.models.AidenPairingExchange
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.persistence.AidenChatDraftStore
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability

/**
 * Revision 61 in a workspace chat: a typed card settles to its answered line at once, a refusal
 * brings the card back without the line, and the line never outlives its approval or its run.
 */
class AidenChatAnsweredApprovalTest {
    private val json = Json { ignoreUnknownKeys = true }

    private suspend fun ViewModelStore.clearAndJoin() = withContext(NonCancellable) {
        val jobs = keys().mapNotNull { get(it)?.viewModelScope?.coroutineContext?.get(Job) }
        clear()
        jobs.forEach { it.join() }
    }

    private fun approval(id: String) = """{"approvalId":"$id","streamId":"stream-ans","chatId":"chat-ans","summary":"Run command: npm test","toolCallId":"tool-$id","toolName":"run_command","expiresAt":"2099-01-01T00:00:00Z","canAllow":true,"scopes":["once"],"card":{"kind":"mac","mac":"shell","title":"Run on your Mac?","arguments":[{"key":"tool","value":"Run command"}],"body":{"format":"command","text":"npm test"},"buttons":[{"label":"Deny","decision":"deny","answered":"Denied"},{"label":"Allow once","decision":"allow","answered":"Allowed once"}]}}"""

    @Test
    fun theAnsweredLineShowsAtOnceRollsBackOnRefusalAndClearsForTheNextApprovalAndTheRunsEnd() = exercise(unpairDuringAnswer = false)

    @Test
    fun anUnconfirmedAnswerLeavesNoLineEvenWhenThePairingWentAwayMeanwhile() = exercise(unpairDuringAnswer = true)

    private fun exercise(unpairDuringAnswer: Boolean) {
        val directory = kotlin.io.path.createTempDirectory("aiden-answered-").toFile()
        val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val server = MockWebServer()
        val viewModels = ViewModelStore()
        val grants = listOf(AidenRemoteCapability.SERVER_READ, AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.CHAT_WRITE, AidenRemoteCapability.APPROVAL_RESPOND)
        val chat = AidenChat(id = "chat-ans", workspaceId = "workspace-ans", title = "Answers", messages = emptyList(),
            createdAt = Instant.EPOCH, updatedAt = Instant.EPOCH, revision = "revision-ans")
        val pending = AtomicReference<String?>("approval-a")
        val state = AtomicReference("waiting_for_approval")
        val terminal = AtomicBoolean(false)
        val refuse = AtomicBoolean(true)
        val arrived = AtomicReference(CountDownLatch(1))
        val release = AtomicReference(CountDownLatch(1))
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                return when {
                    path == "/api/aiden/v1/server" -> MockResponse().setBody("""{"protocolVersion":1,"instanceId":"instance-ans","name":"Answer Mac","appVersion":"1.0","capabilities":${json.encodeToString(grants)},"serverCapabilities":${json.encodeToString(grants)},"features":[],"connectionMode":"lan","serverTime":"2026-11-13T12:00:00Z"}""")
                    path == "/api/aiden/v1/workspaces" -> MockResponse().setBody("""{"workspaces":[]}""")
                    path == "/api/aiden/v1/chats/chat-ans" -> MockResponse().setBody(json.encodeToString(chat))
                    path == "/api/aiden/v1/streams/stream-ans/events" -> MockResponse().setHeader("Content-Type", "text/event-stream").setBody(
                        if (terminal.get()) "id: 1\nevent: done\ndata: {\"protocolVersion\":1,\"streamId\":\"stream-ans\",\"sequence\":1,\"timestamp\":\"2026-11-13T12:00:00Z\",\"type\":\"done\",\"terminal\":true,\"payload\":{\"messageId\":\"message-ans\"}}\n\n" else "")
                    path == "/api/aiden/v1/streams/stream-ans" -> MockResponse().setBody(
                        """{"streamId":"stream-ans","chatId":"chat-ans","turnId":"turn-ans","state":"${if (terminal.get()) "done" else state.get()}","lastSequence":0,"updatedAt":"2026-11-13T12:00:00Z"}""")
                    path == "/api/aiden/v1/streams/stream-ans/approval" ->
                        MockResponse().setBody("""{"approval":${pending.get()?.let(::approval) ?: "null"}}""")
                    request.method == "POST" && path.startsWith("/api/aiden/v1/approvals/") -> {
                        arrived.get().countDown()
                        check(release.get().await(10, TimeUnit.SECONDS))
                        val id = path.removePrefix("/api/aiden/v1/approvals/").removeSuffix("/respond")
                        if (refuse.get()) {
                            MockResponse().setResponseCode(409).setBody("""{"error":{"code":"conflict","message":"Not now","requestId":"request-ans","retryable":false}}""")
                        } else {
                            pending.set(null)
                            state.set("running")
                            MockResponse().setBody("""{"approvalId":"$id","decision":"allow","resolvedAt":"2026-11-13T12:00:01Z"}""")
                        }
                    }
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
                val installation = installations.addInstallation(AidenPairingExchange(
                    instanceId = "instance-ans", deviceId = "device-ans", endpoint = server.url("/api/aiden/v1").toString(),
                    serverSpkiSha256 = "sha256/test", credential = "synthetic-credential", capabilities = grants), null)
                val cache = AidenChatCache(directory)
                val drafts = AidenChatDraftStore(directory)
                val coordinator = AidenRemoteCoordinator(installations, directory, cache, drafts, scope = CoroutineScope(dispatcher + scopeJob))
                coordinator.refreshClient()
                withTimeout(5_000) { coordinator.serverInfo.first { it != null } }
                cache.saveActiveStream(AidenChatCache.ActiveStream("device-ans", "stream-ans", "turn-ans", 0), "instance-ans", chat.id)
                val model = AidenChatViewModel(chat.id, coordinator, cache, drafts, chat, recoveryClock = { System.nanoTime() / 1_000_000 })
                viewModels.put("answers", model)
                withTimeout(5_000) { model.pendingApproval.first { it?.id == "approval-a" } }

                // The tap settles the card to its answered line before the Mac replies.
                model.respondToApproval(AidenApprovalDecision.ALLOW, "approval-a")
                withContext(Dispatchers.IO) { assertTrue(arrived.get().await(5, TimeUnit.SECONDS)) }
                assertEquals("Allowed once", model.answeredApproval.value?.answered)
                assertEquals("Run on your Mac?", model.answeredApproval.value?.title)
                assertNull(model.pendingApproval.value)

                if (unpairDuringAnswer) {
                    // The pairing goes while the answer is on its way, and the Mac never confirms it.
                    coordinator.removeInstallation(installation.id)
                    release.get().countDown()
                    withTimeout(5_000) { model.isRespondingToApproval.first { !it } }
                    assertNull(model.answeredApproval.value)
                    return@runBlocking
                }

                // The Mac refuses: the line goes and the card comes back from the Mac.
                release.get().countDown()
                withTimeout(5_000) { model.isRespondingToApproval.first { !it } }
                assertNull(model.answeredApproval.value)
                withTimeout(5_000) { model.pendingApproval.first { it?.id == "approval-a" } }

                // Accepted: the line stays in the card's place.
                refuse.set(false)
                arrived.set(CountDownLatch(1)); release.set(CountDownLatch(0))
                model.respondToApproval(AidenApprovalDecision.ALLOW, "approval-a")
                withTimeout(5_000) { model.isRespondingToApproval.first { !it } }
                assertEquals("approval-a", model.answeredApproval.value?.approvalId)
                assertEquals("Allowed once", model.answeredApproval.value?.answered)

                // The next approval in the run replaces it.
                pending.set("approval-b"); state.set("waiting_for_approval")
                model.restorePendingApproval("stream-ans")
                withTimeout(5_000) { model.pendingApproval.first { it?.id == "approval-b" } }
                withTimeout(5_000) { model.answeredApproval.first { it == null } }

                // Answered again, then the run ends: no line is left for the next turn.
                model.respondToApproval(AidenApprovalDecision.ALLOW, "approval-b")
                withTimeout(5_000) { model.isRespondingToApproval.first { !it } }
                assertEquals("approval-b", model.answeredApproval.value?.approvalId)
                terminal.set(true)
                withTimeout(5_000) { model.streamState.first { it?.isTerminal == true } }
                withTimeout(5_000) { model.answeredApproval.first { it == null } }
            }
        } finally {
            release.get().countDown()
            runBlocking(dispatcher) { viewModels.clearAndJoin(); scopeJob.cancelAndJoin() }
            Dispatchers.resetMain()
            dispatcher.close()
            server.shutdown()
            directory.deleteRecursively()
        }
    }
}
