package sbtbiswas.AidenOnTheGo

import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.features.chat.AidenChatViewModel
import sbtbiswas.AidenOnTheGo.features.chat.AidenContinueInNewChat
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.features.remote.aidenProgressCapabilitiesToRequest
import sbtbiswas.AidenOnTheGo.features.remote.aidenRequestChatContinueInNewChat
import sbtbiswas.AidenOnTheGo.features.remote.aidenShouldRequestChatContinueInNewChat
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.persistence.AidenChatDraftStore
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteContractException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import sbtbiswas.AidenOnTheGo.protocol.AidenWorkspaceUnavailableReason
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Contract revision 63 (`chat:continue-in-new-chat`), read from the fixture every client shares. */
class AidenContinueInNewChatTest {
    private val fixture: JsonObject by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json")) { "contract.json" }
            .bufferedReader().use { it.readText() }
        Json.parseToJsonElement(text).jsonObject
    }
    private val section get() = fixture.getValue("continueInNewChat").jsonObject
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    private lateinit var server: MockWebServer
    private lateinit var client: AidenRemoteClient

    @Before
    fun setup() {
        server = MockWebServer()
        server.start()
        client = AidenRemoteClient(
            endpoint = server.url("/api/aiden/v1").toString().trimEnd('/'),
            credential = "test_credential_123",
            customOkHttpClient = OkHttpClient()
        )
    }

    @After
    fun teardown() {
        server.shutdown()
    }

    private fun reply(status: Int, body: JsonElement) =
        MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody(body.toString())

    private val sourceChat = AidenChat(
        id = "chat_fixture_missing_folder_01",
        workspaceId = "workspace_fixture_01",
        title = "Parser cleanup",
        messages = emptyList(),
        createdAt = Instant.parse("2026-11-10T09:00:00Z"),
        updatedAt = Instant.parse("2026-11-10T09:00:00Z"),
        revision = "chat_revision_missing_1"
    )

    /** Sends a turn the Mac refuses with [body], through the real client and its error parser. */
    private fun refusedTurn(body: JsonElement): AidenRemoteClientException.Server {
        server.enqueue(reply(409, body))
        return assertThrows(AidenRemoteClientException.Server::class.java) {
            runBlocking { client.startTurn(sourceChat.id, AidenTurnStart(text = "Keep going")) }
        }
    }

    private fun withDetails(vararg entries: Pair<String, JsonElement>): JsonObject {
        val refused = section.getValue("refused").jsonObject
        val error = refused.getValue("error").jsonObject
        val details = JsonObject(error.getValue("details").jsonObject + entries)
        return JsonObject(mapOf("error" to JsonObject(error + ("details" to details))))
    }

    @Test
    fun aRefusalThatOffersContinuingDecodesItsReasonAndOffersTheAction() {
        val refused = refusedTurn(section.getValue("refused"))
        assertEquals(AidenRemoteErrorCode.WORKSPACE_UNAVAILABLE, refused.body.code)
        val details = requireNotNull(refused.body.details)
        assertEquals(AidenWorkspaceUnavailableReason.FOLDER_MISSING, details.workspaceUnavailableReason)
        assertEquals(true, details.canContinueInNewChat)
        val offer = requireNotNull(AidenContinueInNewChat.offer(refused, sourceChat))
        assertEquals(refused.body.message, offer.message)
        assertNull("a Bot chat never offers it", AidenContinueInNewChat.offer(refused, sourceChat.copy(botId = "bot_1")))
    }

    @Test
    fun aRefusalWithoutDetailsOrThatSaysNoOffersNothing() {
        val plain = refusedTurn(section.getValue("plainRefusal"))
        assertNull(plain.body.details)
        assertNull(AidenContinueInNewChat.offer(plain, sourceChat))

        val declined = refusedTurn(withDetails("canContinueInNewChat" to JsonPrimitive(false)))
        assertEquals(AidenWorkspaceUnavailableReason.FOLDER_MISSING, declined.body.details?.workspaceUnavailableReason)
        assertNull(AidenContinueInNewChat.offer(declined, sourceChat))
    }

    @Test
    fun aReasonThisBuildDoesNotKnowStillDecodesAndStillOffers() {
        val refused = refusedTurn(withDetails("reason" to JsonPrimitive("volume_ejected")))
        val details = requireNotNull(refused.body.details)
        assertNull(details.workspaceUnavailableReason)
        assertEquals("volume_ejected", details.reason)
        assertNotNull(AidenContinueInNewChat.offer(refused, sourceChat))

        val worktree = refusedTurn(withDetails("reason" to JsonPrimitive("worktree_missing")))
        assertEquals(AidenWorkspaceUnavailableReason.WORKTREE_MISSING, worktree.body.details?.workspaceUnavailableReason)
    }

    @Test
    fun continuingSendsTheDestinationWithTheRevisionAndKeyAndReadsTheNewChat() = runBlocking<Unit> {
        server.enqueue(reply(201, section.getValue("response")))
        val key = UUID.randomUUID()

        val result = client.continueChatInNewChat(sourceChat.id, sourceChat.revision, "workspace_fixture_02", key)
        assertEquals("chat_fixture_continue_01", result.chat.id)
        assertEquals("workspace_fixture_02", result.chat.workspaceId)
        assertEquals(2, result.chat.messages.size)
        assertEquals(sourceChat.id, result.chat.forkedFrom?.chatId)
        assertNull(result.prefill)
        val request = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("POST", request.method)
        assertEquals("/api/aiden/v1/chats/${sourceChat.id}/fork", request.requestUrl!!.encodedPath)
        assertEquals(sourceChat.revision, request.getHeader("If-Match"))
        assertEquals(key.toString().lowercase(), request.getHeader("Idempotency-Key")?.lowercase())
        assertEquals(section.getValue("request"), Json.parseToJsonElement(request.body.readUtf8()))

        // A reply that is not a new chat in the chosen workspace is refused.
        val response = section.getValue("response").jsonObject
        val chatJson = response.getValue("chat").jsonObject
        val elsewhere = JsonObject(response + ("chat" to JsonObject(chatJson + ("workspaceId" to JsonPrimitive("workspace_fixture_03")))))
        val sameChat = JsonObject(response + ("chat" to JsonObject(chatJson + ("id" to JsonPrimitive(sourceChat.id)))))
        val noLineage = JsonObject(response + ("chat" to JsonObject(chatJson - "forkedFrom")))
        val lineage = chatJson.getValue("forkedFrom").jsonObject
        val foreignLineage = JsonObject(response + ("chat" to JsonObject(
            chatJson + ("forkedFrom" to JsonObject(lineage + ("chatId" to JsonPrimitive("chat_someone_else"))))
        )))
        for ((why, body, refusal) in listOf(
            Triple("another workspace", elsewhere, AidenRemoteClientException::class.java),
            Triple("the source chat", sameChat, AidenRemoteClientException::class.java),
            Triple("no source recorded", noLineage, AidenRemoteContractException::class.java),
            Triple("another source recorded", foreignLineage, AidenRemoteClientException::class.java)
        )) {
            server.enqueue(reply(201, body))
            assertThrows(why, refusal) {
                runBlocking { client.continueChatInNewChat(sourceChat.id, sourceChat.revision, "workspace_fixture_02") }
            }
            server.takeRequest(5, TimeUnit.SECONDS)
        }
    }

    private val holds = listOf(
        AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.CHAT_WRITE, AidenRemoteCapability.CHAT_CONTINUE_IN_NEW_CHAT
    )

    private fun mac(capabilities: List<AidenRemoteCapability>, offers: List<AidenRemoteCapability> = listOf(AidenRemoteCapability.CHAT_CONTINUE_IN_NEW_CHAT)) =
        AidenServer(instanceId = "test_instance", name = "Mac", capabilities = capabilities, serverCapabilities = (capabilities + offers).distinct())

    private fun installationHolding(held: List<AidenRemoteCapability>) = AidenInstallation(
        instanceId = "test_instance",
        deviceId = "test_device",
        name = "Mac",
        endpoint = "https://aiden.test/api/aiden/v1",
        serverSpkiSha256 = "sha256/test",
        deviceCapabilities = held,
        serverCapabilities = held,
        createdAt = Instant.parse("2026-11-11T08:00:00Z")
    )

    @Test
    fun theGrantIsAskedForAloneOnlyFromAMacThatOffersIt() = runBlocking {
        val base = listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.CHAT_WRITE)
        val offering = mac(base)
        assertFalse("offered is not held", offering.supportsContinueInNewChat)
        assertTrue(aidenShouldRequestChatContinueInNewChat(offering, installationHolding(base)))
        assertFalse(aidenProgressCapabilitiesToRequest(offering, installationHolding(base)).contains(AidenRemoteCapability.CHAT_CONTINUE_IN_NEW_CHAT))
        assertFalse("not offered", aidenShouldRequestChatContinueInNewChat(mac(base, emptyList()), installationHolding(base)))
        assertFalse("already held", aidenShouldRequestChatContinueInNewChat(mac(holds), installationHolding(holds)))
        assertTrue(mac(holds).supportsContinueInNewChat)
        assertFalse("needs chat:write too", mac(holds - AidenRemoteCapability.CHAT_WRITE).supportsContinueInNewChat)

        val names = base.map { it.rawValue } + section.getValue("capability").jsonPrimitive.content
        val listed = JsonArray(names.map { JsonPrimitive(it) })
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"capabilities":$listed}"""))
        server.enqueue(MockResponse().setResponseCode(200).setBody(
            """{"protocolVersion":1,"instanceId":"test_instance","name":"Mac","appVersion":"1.0.0","connectionMode":"lan",
               "serverTime":"2026-11-11T08:00:00.000Z","capabilities":$listed,"serverCapabilities":$listed}"""
        ))
        val granted = requireNotNull(aidenRequestChatContinueInNewChat(client, offering, installationHolding(base)))
        val ask = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("/api/aiden/v1/device/capabilities", ask.path)
        assertEquals(
            listOf("chat:continue-in-new-chat"),
            Json.parseToJsonElement(ask.body.readUtf8()).jsonObject.getValue("accepts").jsonArray.map { it.jsonPrimitive.content }
        )
        assertEquals(base + AidenRemoteCapability.CHAT_CONTINUE_IN_NEW_CHAT, granted.granted)
        assertTrue(granted.server.supportsContinueInNewChat)

        server.enqueue(MockResponse().setResponseCode(400).setBody(
            """{"error":{"code":"invalid_request","message":"Unknown capability.","requestId":"req_1","retryable":false}}"""
        ))
        assertNull("a Mac that refuses the name leaves the pairing as it was", aidenRequestChatContinueInNewChat(client, offering, installationHolding(base)))
    }

    private fun workspace(id: String, name: String, noWorkspace: Boolean = false, createdAt: Instant? = null) = AidenWorkspace(
        id = id, name = name, permission = AidenWorkspacePermission.ASK, hasFolder = true,
        noWorkspace = noWorkspace, createdAt = createdAt, revision = "workspace_revision_$id"
    )

    @Test
    fun thePickerListsTheOtherWorkspacesAsTheNewChatListNamesThem() {
        val workspaces = listOf(
            workspace("workspace_fixture_01", "Parser"),
            workspace("workspace_fixture_02", "Site"),
            workspace("workspace_archived", "Old"),
            workspace("default", "default", noWorkspace = true, createdAt = Instant.parse("2026-01-01T00:00:00Z")),
            workspace("no_workspace_2", "no_workspace_2", noWorkspace = true, createdAt = Instant.parse("2026-02-01T00:00:00Z"))
        )
        val archived = setOf("workspace_archived", "default")
        val destinations = AidenContinueInNewChat.destinations(workspaces, "workspace_fixture_01") { it in archived }
        assertEquals(listOf("workspace_fixture_02", "default"), destinations.map { it.id })
        assertEquals(listOf("Site", AidenNoWorkspace.GROUP_NAME), destinations.map { AidenNoWorkspace.label(it) })

        // A chat in the Chats group continues in a real workspace, not back in the group.
        assertEquals(
            listOf("workspace_fixture_01", "workspace_fixture_02"),
            AidenContinueInNewChat.destinations(workspaces, "default") { it in archived }.map { it.id }
        )
    }

    private suspend fun ViewModelStore.clearAndJoin() = withContext(NonCancellable) {
        val jobs = keys().mapNotNull { get(it)?.viewModelScope?.coroutineContext?.get(Job) }
        clear()
        jobs.forEach { it.join() }
    }

    /** Runs a chat view model against [dispatch], with a pairing that may write chats. */
    private fun withChatModel(
        prefix: String,
        dispatch: (RecordedRequest) -> MockResponse,
        body: suspend (AidenChatViewModel) -> Unit
    ) {
        val directory = kotlin.io.path.createTempDirectory(prefix).toFile()
        val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val chatServer = MockWebServer()
        val viewModels = ViewModelStore()
        chatServer.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = dispatch(request)
        }
        chatServer.start()
        Dispatchers.setMain(dispatcher)
        try {
            runBlocking(dispatcher) {
                val installations = AidenInstallationStore(directory, InMemoryAidenSecureStore())
                installations.addInstallation(
                    AidenPairingExchange(
                        instanceId = "instance-continue", deviceId = "device-continue",
                        endpoint = chatServer.url("/api/aiden/v1").toString(), serverSpkiSha256 = "sha256/test",
                        credential = "synthetic-credential",
                        capabilities = holds
                    ), null
                )
                val drafts = AidenChatDraftStore(directory)
                val cache = AidenChatCache(directory)
                val coordinator = AidenRemoteCoordinator(
                    installations, directory, cache, drafts,
                    scope = CoroutineScope(dispatcher + Job().apply { cancel() })
                )
                coordinator.refreshClient()
                val model = AidenChatViewModel(sourceChat.id, coordinator, cache, drafts, sourceChat, recoveryClock = { System.nanoTime() / 1_000_000 })
                viewModels.put("chat", model)
                yield()
                withTimeout(5_000) { model.isLoading.first { !it } }
                body(model)
            }
        } finally {
            runBlocking(dispatcher) { viewModels.clearAndJoin() }
            Dispatchers.resetMain()
            dispatcher.close()
            chatServer.shutdown()
            directory.deleteRecursively()
        }
    }

    @Test
    fun aRefusedSendOffersContinuingAndPickingAWorkspaceOpensTheNewChat() {
        val forks = CopyOnWriteArrayList<RecordedRequest>()
        val busyDestination = JsonObject(mapOf("error" to JsonObject(mapOf(
            "code" to JsonPrimitive("operation_in_progress"),
            "message" to JsonPrimitive("That workspace's folder is missing on your Mac too. Choose another workspace."),
            "requestId" to JsonPrimitive("req_continue_busy"),
            "retryable" to JsonPrimitive(false)
        ))))
        withChatModel("aiden-continue-", { request ->
            when (request.requestUrl!!.encodedPath) {
                "/api/aiden/v1/chats/${sourceChat.id}/turns" -> reply(409, section.getValue("refused"))
                "/api/aiden/v1/chats/${sourceChat.id}/fork" -> {
                    forks.add(request)
                    if (forks.size == 1) reply(409, busyDestination) else reply(201, section.getValue("response"))
                }
                "/api/aiden/v1/chats/${sourceChat.id}" -> MockResponse().setBody(json.encodeToString(sourceChat))
                else -> MockResponse().setResponseCode(404)
            }
        }) { model ->
            model.updateDraft("Keep going")
            model.send()
            withTimeout(5_000) { model.isStarting.first { !it } }
            val refusal = section.getValue("refused").jsonObject.getValue("error").jsonObject.getValue("message").jsonPrimitive.content
            assertEquals(refusal, model.presentedError.value)
            assertEquals(refusal, model.continueInNewChatOffer.value?.message)

            // The destination's folder is missing too: the Mac's sentence shows and another pick stays open.
            model.continueInNewChat("workspace_fixture_03")
            withTimeout(5_000) { model.isForking.first { it } }
            withTimeout(5_000) { model.isForking.first { !it } }
            assertEquals("That workspace's folder is missing on your Mac too. Choose another workspace.", model.presentedError.value)
            assertNotNull(model.continueInNewChatOffer.value)
            assertNull(model.forkNavigation.value)

            model.continueInNewChat("workspace_fixture_02")
            withTimeout(5_000) { model.forkNavigation.first { it != null } }
            assertEquals("chat_fixture_continue_01", model.forkNavigation.value)
            assertNull(model.continueInNewChatOffer.value)
            assertNull(model.presentedError.value)

            assertEquals(2, forks.size)
            for (fork in forks) {
                assertEquals("POST", fork.method)
                assertEquals(sourceChat.revision, fork.getHeader("If-Match"))
                assertNotNull(fork.getHeader("Idempotency-Key"))
            }
            assertEquals(
                listOf("workspace_fixture_03", "workspace_fixture_02"),
                forks.map { Json.parseToJsonElement(it.body.readUtf8()).jsonObject.getValue("continueIn").jsonObject.getValue("workspaceId").jsonPrimitive.content }
            )
            // This chat stays as it is.
            assertEquals(sourceChat.id, model.chat.value?.id)
            assertEquals(sourceChat.workspaceId, model.chat.value?.workspaceId)
        }
    }

    @Test
    fun aRefusalWithoutTheOfferShowsOnlyTheMacsReason() {
        val forks = CopyOnWriteArrayList<RecordedRequest>()
        withChatModel("aiden-continue-plain-", { request ->
            when (request.requestUrl!!.encodedPath) {
                "/api/aiden/v1/chats/${sourceChat.id}/turns" -> reply(409, section.getValue("plainRefusal"))
                "/api/aiden/v1/chats/${sourceChat.id}/fork" -> { forks.add(request); reply(201, section.getValue("response")) }
                "/api/aiden/v1/chats/${sourceChat.id}" -> MockResponse().setBody(json.encodeToString(sourceChat))
                else -> MockResponse().setResponseCode(404)
            }
        }) { model ->
            model.updateDraft("Keep going")
            model.send()
            withTimeout(5_000) { model.isStarting.first { !it } }
            assertNotNull(model.presentedError.value)
            assertNull(model.continueInNewChatOffer.value)
            model.continueInNewChat("workspace_fixture_02")
            yield()
            assertFalse(model.isForking.value)
            assertTrue("no offer, no request", forks.isEmpty())
            assertEquals("Keep going", model.draft.value)
        }
    }
}
