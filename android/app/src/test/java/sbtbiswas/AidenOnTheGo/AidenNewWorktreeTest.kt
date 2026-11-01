package sbtbiswas.AidenOnTheGo

import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
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
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.features.chat.AidenChatViewModel
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.features.remote.aidenProgressCapabilitiesToRequest
import sbtbiswas.AidenOnTheGo.features.remote.aidenRequestChatNewWorktree
import sbtbiswas.AidenOnTheGo.features.remote.aidenShouldRequestChatNewWorktree
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.persistence.AidenChatDraftStore
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorEnvelope
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Contract revision 50 (`chat:new-worktree`), read from the fixture every client shares. */
class AidenNewWorktreeTest {
    private val fixture: JsonObject by lazy {
        val text = requireNotNull(javaClass.classLoader?.getResourceAsStream("contract.json")) { "contract.json" }
            .bufferedReader().use { it.readText() }
        Json.parseToJsonElement(text).jsonObject
    }
    private val newWorktree get() = fixture.getValue("chatNewWorktree").jsonObject

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

    private val holds = listOf(
        AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.CHAT_WRITE,
        AidenRemoteCapability.GIT_WRITE, AidenRemoteCapability.CHAT_NEW_WORKTREE
    )

    private fun mac(capabilities: List<AidenRemoteCapability> = holds, offers: List<AidenRemoteCapability> = listOf(AidenRemoteCapability.CHAT_NEW_WORKTREE)) =
        AidenServer(
            instanceId = "test_instance",
            name = "Mac",
            capabilities = capabilities,
            serverCapabilities = (capabilities + offers).distinct()
        )

    private fun installationHolding(held: List<AidenRemoteCapability>) = AidenInstallation(
        instanceId = "test_instance",
        deviceId = "test_device",
        name = "Mac",
        endpoint = "https://aiden.test/api/aiden/v1",
        serverSpkiSha256 = "sha256/test",
        deviceCapabilities = held,
        serverCapabilities = held,
        createdAt = Instant.parse("2026-10-29T09:00:00Z")
    )

    private val site = AidenWorkspace(
        id = "workspace_site",
        name = "Site",
        permission = AidenWorkspacePermission.ASK,
        hasFolder = true,
        isManagedWorktree = false,
        revision = "workspace_revision_1"
    )

    private fun chat(workspaceId: String = site.id, botId: String? = null, messages: List<AidenChatMessage> = emptyList()) = AidenChat(
        id = "chat_new",
        workspaceId = workspaceId,
        botId = botId,
        title = "New chat",
        messages = messages,
        createdAt = Instant.parse("2026-10-29T09:00:00Z"),
        updatedAt = Instant.parse("2026-10-29T09:00:00Z"),
        revision = "chat_revision_1"
    )

    @Test
    fun theGrantIsAskedForAloneOnlyFromAMacThatOffersIt() = runBlocking {
        val base = listOf(AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.CHAT_WRITE, AidenRemoteCapability.GIT_WRITE)
        val offering = mac(base)
        assertFalse("offered is not held", offering.supportsNewWorktrees)
        assertTrue(aidenShouldRequestChatNewWorktree(offering, installationHolding(base)))
        assertFalse(aidenProgressCapabilitiesToRequest(offering, installationHolding(base)).contains(AidenRemoteCapability.CHAT_NEW_WORKTREE))
        assertFalse("not offered", aidenShouldRequestChatNewWorktree(mac(base, emptyList()), installationHolding(base)))

        val names = base.map { it.rawValue } + "chat:new-worktree"
        val listed = JsonArray(names.map { JsonPrimitive(it) })
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"capabilities":$listed}"""))
        server.enqueue(MockResponse().setResponseCode(200).setBody(
            """{"protocolVersion":1,"instanceId":"test_instance","name":"Mac","appVersion":"1.0.0","connectionMode":"lan",
               "serverTime":"2026-10-29T09:00:00.000Z","capabilities":$listed,"serverCapabilities":$listed}"""
        ))
        val granted = requireNotNull(aidenRequestChatNewWorktree(client, offering, installationHolding(base)))
        val ask = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("/api/aiden/v1/device/capabilities", ask.path)
        assertEquals(
            listOf("chat:new-worktree"),
            Json.parseToJsonElement(ask.body.readUtf8()).jsonObject.getValue("accepts").jsonArray.map { it.jsonPrimitive.content }
        )
        assertEquals(base + AidenRemoteCapability.CHAT_NEW_WORKTREE, granted.granted)
        assertTrue(granted.server.supportsNewWorktrees)

        server.enqueue(MockResponse().setResponseCode(400).setBody(
            """{"error":{"code":"invalid_request","message":"Unknown capability.","requestId":"req_1","retryable":false}}"""
        ))
        assertNull("a Mac that refuses the name leaves the pairing as it was", aidenRequestChatNewWorktree(client, offering, installationHolding(base)))
    }

    @Test
    fun movesTheEmptyChatWithItsFirstMessageAndRefusesAnythingElse() = runBlocking<Unit> {
        val moved = newWorktree.getValue("response").jsonObject
        server.enqueue(reply(200, moved))
        val key = UUID.randomUUID()

        val result = client.moveChatToNewWorktree("chat_fixture_new_worktree", "chat_revision_new_worktree_1", "Fix the login bug", key)
        assertEquals("workspace_fixture_worktree", result.chat.workspaceId)
        assertEquals("chat_revision_new_worktree_2", result.chat.revision)
        assertEquals("aiden/fix-the-login-bug", result.branch)
        val request = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("POST", request.method)
        assertEquals("/api/aiden/v1/chats/chat_fixture_new_worktree/worktree", request.requestUrl!!.encodedPath)
        assertEquals("chat_revision_new_worktree_1", request.getHeader("If-Match"))
        assertEquals(key.toString().lowercase(), request.getHeader("Idempotency-Key")?.lowercase())
        assertEquals(newWorktree.getValue("request"), Json.parseToJsonElement(request.body.readUtf8()))

        // The Mac's own sentence is what the phone shows.
        server.enqueue(reply(409, newWorktree.getValue("failed")))
        val refused = assertThrows(AidenRemoteClientException.Server::class.java) {
            runBlocking { client.moveChatToNewWorktree("chat_fixture_new_worktree", "chat_revision_new_worktree_1", "Fix the login bug") }
        }
        assertEquals(409, refused.statusCode)
        assertTrue(refused.message!!.contains("couldn't fetch main"))

        val fixtureMessage = fixture.getValue("chat").jsonObject.getValue("messages").jsonArray.first()
        val chatJson = moved.getValue("chat").jsonObject
        val notEmpty = JsonObject(moved + ("chat" to JsonObject(chatJson + ("messages" to JsonArray(listOf(fixtureMessage))))))
        val extraKey = JsonObject(moved + ("path" to JsonPrimitive("/Users/sam/.aiden/worktrees/site")))
        val otherChat = JsonObject(moved + ("chat" to JsonObject(chatJson + ("id" to JsonPrimitive("chat_other")))))
        for ((why, body) in listOf("a chat with messages" to notEmpty, "an unknown field" to extraKey, "another chat" to otherChat)) {
            server.enqueue(reply(200, body))
            assertThrows(why, AidenRemoteClientException.InvalidResponse::class.java) {
                runBlocking { client.moveChatToNewWorktree("chat_fixture_new_worktree", "chat_revision_new_worktree_1", "Fix the login bug") }
            }
        }
        // A first message of attachments only still makes a worktree: the Mac refuses a blank
        // name, so the phone names it the way the desktop does.
        server.enqueue(reply(200, moved))
        client.moveChatToNewWorktree("chat_fixture_new_worktree", "r", "  \n ")
        val untitled = generateSequence { server.takeRequest(100, TimeUnit.MILLISECONDS) }.last()
        assertEquals("New chat", Json.parseToJsonElement(untitled.body.readUtf8()).jsonObject.getValue("text").jsonPrimitive.content)
    }

    @Test
    fun aLongFirstMessageIsCutAtTheMacsLimitNotRefused() = runBlocking<Unit> {
        // The Mac counts code points: a long first message is cut there, not refused on the phone.
        server.enqueue(reply(200, newWorktree.getValue("response").jsonObject))
        val emoji = "\uD83D\uDE80"
        client.moveChatToNewWorktree("chat_fixture_new_worktree", "chat_revision_new_worktree_1", "Fix " + emoji.repeat(5_000))
        val longText = Json.parseToJsonElement(server.takeRequest(5, TimeUnit.SECONDS)!!.body.readUtf8())
            .jsonObject.getValue("text").jsonPrimitive.content
        assertEquals(AidenChatNewWorktree.MAX_TEXT_LENGTH, longText.codePointCount(0, longText.length))
        assertTrue(longText.startsWith("Fix $emoji"))
        assertTrue("never cut inside a character", longText.endsWith(emoji))
    }

    @Test
    fun onlyARequestTheMacNeverAnsweredKeepsItsKey() {
        fun refusal(status: Int, code: AidenRemoteErrorCode) =
            AidenRemoteClientException.Server(status, AidenRemoteErrorEnvelope.Body(code, "Refused.", "req_1", false))
        assertTrue(AidenNewWorktreeRetry.spendsKey(refusal(409, AidenRemoteErrorCode("git_capability_denied"))))
        assertTrue(AidenNewWorktreeRetry.spendsKey(refusal(500, AidenRemoteErrorCode.INTERNAL_ERROR)))
        assertTrue(AidenNewWorktreeRetry.spendsKey(AidenRemoteClientException.UnexpectedStatus(502)))
        assertTrue("an answer the phone could not read would only replay", AidenNewWorktreeRetry.spendsKey(AidenRemoteClientException.InvalidResponse()))
        assertFalse("the Mac is still on it", AidenNewWorktreeRetry.spendsKey(refusal(409, AidenRemoteErrorCode.IDEMPOTENCY_IN_FLIGHT)))
        assertFalse(AidenNewWorktreeRetry.spendsKey(java.net.SocketTimeoutException()))
        assertFalse(AidenNewWorktreeRetry.spendsKey(AidenRemoteClientException.Disconnected()))
    }

    @Test
    fun offeredOnlyWhereTheMacCanMakeAWorktree() {
        assertTrue(AidenNewWorktreeAvailability.isOffered(chat(), site, mac(), hasCommits = null))
        assertTrue(AidenNewWorktreeAvailability.isOffered(chat(), site, mac(), hasCommits = true))

        val message = AidenChatMessage(id = "m1", role = AidenChatRole.USER, text = "Hi", createdAt = Instant.parse("2026-10-29T09:00:01Z"))
        val hidden = mapOf(
            "chat has a message" to AidenNewWorktreeAvailability.isOffered(chat(messages = listOf(message)), site, mac(), null),
            "Bot chat" to AidenNewWorktreeAvailability.isOffered(chat(botId = "bot_1"), site, mac(), null),
            "no folder" to AidenNewWorktreeAvailability.isOffered(chat(), site.copy(hasFolder = false), mac(), null),
            "already a worktree" to AidenNewWorktreeAvailability.isOffered(chat(), site.copy(isManagedWorktree = true), mac(), null),
            "no folder access" to AidenNewWorktreeAvailability.isOffered(chat(), site.copy(permission = AidenWorkspacePermission.NONE), mac(), null),
            "another chat's workspace" to AidenNewWorktreeAvailability.isOffered(chat(workspaceId = "workspace_other"), site, mac(), null),
            "not a repository, or no commits" to AidenNewWorktreeAvailability.isOffered(chat(), site, mac(), hasCommits = false),
            "Mac on an earlier revision" to AidenNewWorktreeAvailability.isOffered(chat(), site, mac(holds - AidenRemoteCapability.CHAT_NEW_WORKTREE, emptyList()), null),
            "offered but not granted" to AidenNewWorktreeAvailability.isOffered(chat(), site, mac(holds - AidenRemoteCapability.CHAT_NEW_WORKTREE), null),
            "no git:write" to AidenNewWorktreeAvailability.isOffered(chat(), site, mac(holds - AidenRemoteCapability.GIT_WRITE), null),
            "read-only chat grant" to AidenNewWorktreeAvailability.isOffered(chat(), site, mac(holds - AidenRemoteCapability.CHAT_WRITE), null),
            "no workspace" to AidenNewWorktreeAvailability.isOffered(chat(), null, mac(), null),
            "not connected" to AidenNewWorktreeAvailability.isOffered(chat(), site, null, null)
        )
        for ((why, offered) in hidden) assertFalse(why, offered)
    }

    @Test
    fun theMacsBranchListTellsWhetherTheRepositoryHasCommits() = runBlocking {
        // The Mac sends every Git projection under `result`, tagged by `kind`.
        fun branches(allowed: Boolean, names: List<String>, unborn: Boolean = false) = JsonObject(mapOf(
            "operationId" to JsonPrimitive("op_" + "A".repeat(32)),
            "status" to JsonPrimitive("snapshot"),
            "snapshotId" to JsonPrimitive("git_snapshot_1"),
            "capability" to JsonObject(buildMap<String, JsonElement> {
                put("allowed", JsonPrimitive(allowed))
                if (!allowed) put("reason", JsonPrimitive("This workspace is not a Git repository."))
            }),
            "result" to JsonObject(buildMap<String, JsonElement> {
                put("kind", JsonPrimitive("branches"))
                put("current", JsonPrimitive("main"))
                put("branches", JsonArray(names.map { JsonPrimitive(it) }))
                if (unborn) put("unborn", JsonPrimitive(true))
            })
        ))
        server.enqueue(reply(200, branches(allowed = true, names = listOf("main", "fix"))))
        server.enqueue(reply(200, branches(allowed = false, names = emptyList())))
        // A repository with no commits still names the branch its first commit will make.
        server.enqueue(reply(200, branches(allowed = true, names = listOf("main"), unborn = true)))

        val repository = client.gitBranches(site.id)
        assertEquals(listOf("main", "fix"), repository.branches?.branches)
        assertNull(repository.result)
        assertEquals(true, AidenNewWorktreeAvailability.hasCommits(repository))
        assertEquals(false, AidenNewWorktreeAvailability.hasCommits(client.gitBranches(site.id)))
        assertEquals(false, AidenNewWorktreeAvailability.hasCommits(client.gitBranches(site.id)))
        assertEquals("/api/aiden/v1/workspaces/workspace_site/git/branches", server.takeRequest(5, TimeUnit.SECONDS)?.path)
    }

    @Test
    fun theSharedGitReviewExampleLandsOnItsTypedField() {
        val review = Json { ignoreUnknownKeys = true }.decodeFromJsonElement(AidenGitResultWire, fixture.getValue("git"))
        assertEquals("feature/mobile", review.review?.branch)
        assertNull(review.result)
        assertNull(AidenNewWorktreeAvailability.hasCommits(review))
    }

    // --- Sending the first message into a new worktree, through the chat screen's model ---

    private val wire = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }
    private val emptyChat = AidenChat(
        id = "chat-new", workspaceId = site.id, title = "New chat", messages = emptyList(),
        createdAt = Instant.EPOCH, updatedAt = Instant.EPOCH, revision = "chat-r1"
    )
    private val worktreeWorkspace = site.copy(
        id = "workspace-worktree", name = "Site", isManagedWorktree = true,
        branchName = "aiden/fix-the-header", revision = "workspace_revision_2"
    )
    private val movedChat = emptyChat.copy(workspaceId = worktreeWorkspace.id, revision = "chat-r2")
    private val question = AidenChatMessage(id = "question-1", role = AidenChatRole.USER, text = "Fix the header", createdAt = Instant.EPOCH)

    /** What the Mac was sent, and the chat as the Mac holds it. */
    private class Mac(initial: AidenChat) {
        val chat = AtomicReference(initial)
        private val posts: MutableList<RecordedRequest> = java.util.Collections.synchronizedList(mutableListOf())
        fun record(request: RecordedRequest) { if (request.method == "POST") posts.add(request) }
        fun posted(): List<String> = synchronized(posts) { posts.map { it.requestUrl!!.encodedPath.removePrefix("/api/aiden/v1") } }
        fun worktreeKeys(): List<String?> = synchronized(posts) {
            posts.filter { it.requestUrl!!.encodedPath.endsWith("/worktree") }.map { it.getHeader("Idempotency-Key") }
        }
    }

    /**
     * A phone paired with a Mac that offers New worktree, on the empty chat in [site]. [route]
     * answers what it knows and returns null for the rest.
     */
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private fun withEmptyWorkspaceChat(
        mac: Mac,
        route: (String) -> MockResponse?,
        body: suspend CoroutineScope.(AidenChatViewModel, AidenChatCache) -> Unit
    ) {
        val directory = kotlin.io.path.createTempDirectory("aiden-new-worktree-").toFile()
        val dispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val macServer = MockWebServer()
        val viewModels = ViewModelStore()
        val scopeJob = Job()
        val grants = listOf(
            AidenRemoteCapability.SERVER_READ, AidenRemoteCapability.CHAT_READ, AidenRemoteCapability.CHAT_WRITE,
            AidenRemoteCapability.GIT_WRITE, AidenRemoteCapability.CHAT_NEW_WORKTREE
        )
        val grantsJson = wire.encodeToString(grants)
        macServer.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                mac.record(request)
                val path = request.requestUrl!!.encodedPath.removePrefix("/api/aiden/v1")
                route(path)?.let { return it }
                return when (path) {
                    "/server" -> MockResponse().setBody(
                        """{"protocolVersion":1,"instanceId":"instance-worktree","name":"Mac","appVersion":"1.0","capabilities":$grantsJson,"serverCapabilities":$grantsJson,"features":[],"connectionMode":"lan","serverTime":"2026-10-31T09:00:00Z"}"""
                    )
                    "/workspaces" -> MockResponse().setBody("""{"workspaces":${wire.encodeToString(listOf(site, worktreeWorkspace))}}""")
                    "/chats/${emptyChat.id}" -> MockResponse().setBody(wire.encodeToString(mac.chat.get()))
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        macServer.start()
        Dispatchers.setMain(dispatcher)
        try {
            runBlocking(dispatcher) {
                val installations = AidenInstallationStore(directory, InMemoryAidenSecureStore())
                installations.addInstallation(AidenPairingExchange(
                    instanceId = "instance-worktree", deviceId = "device-worktree", endpoint = macServer.url("/api/aiden/v1").toString(),
                    serverSpkiSha256 = "sha256/test", credential = "synthetic", capabilities = grants
                ), null)
                val cache = AidenChatCache(directory)
                val drafts = AidenChatDraftStore(directory)
                val coordinator = AidenRemoteCoordinator(installations, directory, cache, drafts, scope = CoroutineScope(dispatcher + scopeJob))
                coordinator.refreshClient()
                withTimeout(5_000) { coordinator.serverInfo.first { it != null } }
                withTimeout(5_000) { coordinator.workspaces.first { list -> list.any { it.id == site.id } } }
                val model = AidenChatViewModel(emptyChat.id, coordinator, cache, drafts, emptyChat)
                viewModels.put("chat", model)
                try {
                    withTimeout(5_000) { model.isLoading.first { !it } }
                    body(model, cache)
                } finally {
                    withContext(NonCancellable) {
                        val jobs = viewModels.keys().mapNotNull { viewModels.get(it)?.viewModelScope?.coroutineContext?.get(Job) }
                        viewModels.clear()
                        jobs.forEach { it.join() }
                    }
                }
            }
        } finally {
            scopeJob.cancel()
            Dispatchers.resetMain()
            dispatcher.close()
            macServer.shutdown()
            directory.deleteRecursively()
        }
    }

    @Test
    fun theFirstMessageMovesTheChatIntoItsWorktreeThenSendsThere() {
        val mac = Mac(emptyChat)
        val answer = AidenChatMessage(id = "reply-1", role = AidenChatRole.ASSISTANT, text = "Done", createdAt = Instant.EPOCH)
        withEmptyWorkspaceChat(mac, route = { path ->
            when (path) {
                "/chats/chat-new/worktree" -> {
                    mac.chat.set(movedChat)
                    MockResponse().setBody("""{"chat":${wire.encodeToString(movedChat)},"branch":"aiden/fix-the-header"}""")
                }
                "/chats/chat-new/turns" -> {
                    mac.chat.set(movedChat.copy(messages = listOf(question, answer), revision = "chat-r3"))
                    MockResponse().setResponseCode(202).setBody(
                        """{"turnId":"turn-1","streamId":"stream-1","status":"queued","message":${wire.encodeToString(question)}}"""
                    )
                }
                "/streams/stream-1/events" -> MockResponse().setHeader("Content-Type", "text/event-stream").setBody(
                    "id: 1\nevent: done\ndata: {\"protocolVersion\":1,\"streamId\":\"stream-1\",\"sequence\":1," +
                        "\"timestamp\":\"2026-10-31T09:00:00Z\",\"type\":\"done\",\"terminal\":true,\"payload\":{\"messageId\":\"reply-1\"}}\n\n"
                )
                "/streams/stream-1" -> MockResponse().setBody(
                    """{"streamId":"stream-1","chatId":"chat-new","turnId":"turn-1","state":"done","lastSequence":1,"updatedAt":"2026-10-31T09:00:00Z"}"""
                )
                else -> null
            }
        }) { model, cache ->
            assertTrue(model.offersNewWorktree)
            model.updateDraft("Fix the header")
            model.setStartsInNewWorktree(true)
            model.send()
            withTimeout(10_000) { while (model.isStarting.value || model.hasActiveStream.value) delay(10) }

            assertNull(model.presentedError.value)
            assertEquals("the worktree first, then the turn", listOf("/chats/chat-new/worktree", "/chats/chat-new/turns"), mac.posted())
            assertEquals(worktreeWorkspace.id, model.chat.value?.workspaceId)
            assertEquals("the saved chat stays in the worktree too", worktreeWorkspace.id, cache.loadChat("instance-worktree", emptyChat.id)?.workspaceId)
            assertFalse("the next message is an ordinary one", model.startsInNewWorktree.value)
            assertEquals("", model.draft.value)
        }
    }

    @Test
    fun aRefusalShowsTheMacsSentenceAndCancelPutsTheMessageBackUnsent() {
        val mac = Mac(emptyChat)
        val refusal = "Aiden couldn't fetch main from origin."
        val holdsSetup = AtomicReference(false)
        withEmptyWorkspaceChat(mac, route = { path ->
            when (path) {
                "/chats/chat-new/worktree" ->
                    if (holdsSetup.get()) MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE)
                    else MockResponse().setResponseCode(409).setBody(
                        """{"error":{"code":"git_capability_denied","message":"$refusal","requestId":"worktree-1","retryable":false}}"""
                    )
                "/chats/chat-new/turns" -> MockResponse().setResponseCode(500)
                else -> null
            }
        }) { model, _ ->
            model.updateDraft("Fix the header")
            model.setStartsInNewWorktree(true)
            model.send()
            withTimeout(5_000) { model.isStarting.first { !it } }
            assertEquals(refusal, model.presentedError.value)
            assertEquals("the message is back in the composer", "Fix the header", model.draft.value)
            assertTrue(model.chat.value!!.messages.isEmpty())
            assertEquals(site.id, model.chat.value?.workspaceId)
            assertTrue("sending again tries the worktree again", model.startsInNewWorktree.value)

            // Twice: the Mac never answers, and the person cancels the wait.
            holdsSetup.set(true)
            for (attempt in 2..3) {
                model.send()
                withTimeout(5_000) { model.isSettingUpWorktree.first { it } }
                withTimeout(5_000) { while (mac.worktreeKeys().size < attempt) delay(10) }
                model.cancelWorktreeSetup()
                withTimeout(5_000) { model.isStarting.first { !it } }
                assertFalse(model.isSettingUpWorktree.value)
                assertNull("Cancel is not an error", model.presentedError.value)
                assertEquals("Fix the header", model.draft.value)
                assertTrue(model.chat.value!!.messages.isEmpty())
            }

            val keys = mac.worktreeKeys()
            assertNotEquals("the Mac answered the refusal, so the next request has a new key", keys[0], keys[1])
            assertEquals("a canceled wait got no answer, so the retry keeps its key", keys[1], keys[2])
            assertEquals("no message was sent", List(3) { "/chats/chat-new/worktree" }, mac.posted())
        }
    }

    @Test
    fun aChatThatStoppedQualifyingKeepsItsMessageInsteadOfSendingToTheMainCheckout() {
        val mac = Mac(emptyChat)
        withEmptyWorkspaceChat(mac, route = { path ->
            when (path) {
                "/chats/chat-new/worktree", "/chats/chat-new/turns" -> MockResponse().setResponseCode(500)
                else -> null
            }
        }) { model, _ ->
            assertTrue(model.offersNewWorktree)
            model.updateDraft("Fix the header")
            model.setStartsInNewWorktree(true)

            // Another device moves the still-empty chat into a worktree while the chip is on.
            mac.chat.set(movedChat)
            model.loadChat()
            withTimeout(5_000) { model.chat.first { it?.workspaceId == worktreeWorkspace.id } }
            assertFalse(model.offersNewWorktree)

            model.send()
            withTimeout(5_000) { model.isStarting.first { !it } }
            assertEquals(AidenNewWorktreeCopy.NO_LONGER_OFFERED, model.presentedError.value)
            assertEquals("the message stays in the composer", "Fix the header", model.draft.value)
            assertFalse("the chip is off, so sending again uses the chat's own folder", model.startsInNewWorktree.value)
            assertTrue(model.chat.value!!.messages.isEmpty())
            assertEquals("nothing was sent to the Mac", emptyList<String>(), mac.posted())
        }
    }
}
