package sbtbiswas.AidenOnTheGo

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import sbtbiswas.AidenOnTheGo.features.remote.aidenProgressCapabilitiesToRequest
import sbtbiswas.AidenOnTheGo.features.remote.aidenRequestChatNewWorktree
import sbtbiswas.AidenOnTheGo.features.remote.aidenShouldRequestChatNewWorktree
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteClientException
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorCode
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteErrorEnvelope
import java.time.Instant
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Contract revision 48 (`chat:new-worktree`), read from the fixture every client shares. */
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
        val listed = JsonArray(names.map(::JsonPrimitive))
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
        val sent = server.requestCount
        assertThrows(AidenRemoteClientException.InvalidResponse::class.java) {
            runBlocking { client.moveChatToNewWorktree("chat_fixture_new_worktree", "r", "  \n ") }
        }
        assertEquals("a blank message never reaches the Mac", sent, server.requestCount)

        // The Mac counts code points: a long first message is cut there, not refused on the phone.
        server.enqueue(reply(200, moved))
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
    fun aBranchListTellsWhetherTheRepositoryHasCommits() {
        fun result(branches: List<String>?) = AidenGitResult(
            operationId = "op_1",
            status = AidenGitOperationStatus.SNAPSHOT,
            snapshotId = "s1",
            branches = branches?.let { AidenGitBranches(current = "main", branches = it) }
        )
        assertEquals(true, AidenNewWorktreeAvailability.hasCommits(result(listOf("main", "fix"))))
        assertEquals(false, AidenNewWorktreeAvailability.hasCommits(result(emptyList())))
        assertNull(AidenNewWorktreeAvailability.hasCommits(result(null)))
    }
}
