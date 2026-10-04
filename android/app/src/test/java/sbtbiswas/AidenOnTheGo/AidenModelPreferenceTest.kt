package sbtbiswas.AidenOnTheGo

import androidx.lifecycle.ViewModelStore
import java.io.File
import java.time.Instant
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
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
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.features.chat.AidenChatViewModel
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.persistence.AidenChatDraftStore
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.persistence.AidenModelPreferenceStore
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability

class AidenModelPreferenceTest {
    @get:Rule
    val tempFolder = TemporaryFolder()

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    private val fullCatalog = """
        {"providers":[
          {"id":"google","label":"Google","models":[{"id":"gemini-flash","label":"Gemini Flash"}]},
          {"id":"openai","label":"OpenAI","models":[
            {"id":"gpt-5.6","label":"GPT-5.6","thinkingLevels":["low","medium","max"],"defaultThinkingLevel":"medium"},
            {"id":"gpt-hidden","label":"Hidden","hidden":true}
          ]}
        ],"defaults":{"providerId":"google","modelId":"gemini-flash"}}
    """.trimIndent()

    private val catalogWithoutRemembered = """
        {"providers":[
          {"id":"google","label":"Google","models":[{"id":"gemini-flash","label":"Gemini Flash"}]}
        ],"defaults":{"providerId":"google","modelId":"gemini-flash"}}
    """.trimIndent()

    private fun catalog(body: String): AidenModelCatalog = json.decodeFromString(body)

    private fun workspaceChat(providerId: String? = null, modelId: String? = null) = AidenChat(
        id = "chat-one", workspaceId = "workspace-one", title = "Chat",
        providerId = providerId, modelId = modelId,
        messages = emptyList(), createdAt = Instant.EPOCH, updatedAt = Instant.EPOCH, revision = "r1"
    )

    @Test
    fun rememberedHostChoiceWinsOverChatPairWhileTheHostStillOffersIt() {
        val resolved = AidenChatModelAuthority.resolvedSelection(
            chat = workspaceChat("google", "gemini-flash"),
            catalog = catalog(fullCatalog),
            selectedProviderId = "google",
            selectedModelId = "gemini-flash",
            selectedThinkingLevel = null,
            remembered = AidenChatModelSelection("openai", "gpt-5.6", "max")
        )

        assertEquals(AidenChatModelSelection("openai", "gpt-5.6", "max"), resolved)
    }

    @Test
    fun unsupportedRememberedThinkingLevelFallsBackToTheModelDefault() {
        val resolved = AidenChatModelAuthority.resolvedSelection(
            chat = workspaceChat(),
            catalog = catalog(fullCatalog),
            selectedProviderId = null,
            selectedModelId = null,
            selectedThinkingLevel = null,
            remembered = AidenChatModelSelection("openai", "gpt-5.6", "ultra")
        )

        assertEquals(AidenChatModelSelection("openai", "gpt-5.6", "medium"), resolved)
    }

    @Test
    fun missingOrHiddenRememberedModelFallsBackToChatPairThenHostDefaults() {
        val withChatPair = AidenChatModelAuthority.resolvedSelection(
            chat = workspaceChat("openai", "gpt-5.6"),
            catalog = catalog(fullCatalog),
            selectedProviderId = null,
            selectedModelId = null,
            selectedThinkingLevel = null,
            remembered = AidenChatModelSelection("openai", "gpt-hidden", null)
        )
        assertEquals(AidenChatModelSelection("openai", "gpt-5.6", "medium"), withChatPair)

        val withoutChatPair = AidenChatModelAuthority.resolvedSelection(
            chat = workspaceChat(),
            catalog = catalog(catalogWithoutRemembered),
            selectedProviderId = null,
            selectedModelId = null,
            selectedThinkingLevel = null,
            remembered = AidenChatModelSelection("openai", "gpt-5.6", "max")
        )
        assertEquals(AidenChatModelSelection("google", "gemini-flash", null), withoutChatPair)
    }

    @Test
    fun removedChatModelUsesAVisibleModelFromItsProviderBeforeOtherProviderDefaults() {
        val resolved = AidenChatModelAuthority.resolvedSelection(
            chat = workspaceChat("openai", "removed-model"),
            catalog = catalog(fullCatalog),
            selectedProviderId = null,
            selectedModelId = null,
            selectedThinkingLevel = null,
            remembered = AidenChatModelSelection("missing-provider", "missing-model", null)
        )

        assertEquals(AidenChatModelSelection("openai", "gpt-5.6", "medium"), resolved)
    }

    @Test
    fun botChatsIgnoreTheRememberedWorkspaceChoice() {
        val bot = workspaceChat("google", "gemini-flash").copy(botId = "bot-one")
        val resolved = AidenChatModelAuthority.resolvedSelection(
            chat = bot,
            catalog = catalog(fullCatalog),
            selectedProviderId = null,
            selectedModelId = null,
            selectedThinkingLevel = null,
            remembered = AidenChatModelSelection("openai", "gpt-5.6", "max")
        )

        assertEquals("google", resolved.providerId)
        assertEquals("gemini-flash", resolved.modelId)
    }

    @Test
    fun storeKeepsOneChoicePerPairedHostAcrossRelaunchAndRejectsCorruptFiles() {
        val store = AidenModelPreferenceStore(tempFolder.root)
        store.remember("mac-a", AidenChatModelSelection("openai", "gpt-5.6", "max"))
        store.remember("mac-b", AidenChatModelSelection("google", "gemini-flash", null))
        store.remember("mac-c", AidenChatModelSelection(null, "orphan", null))

        val relaunched = AidenModelPreferenceStore(tempFolder.root)
        assertEquals(AidenChatModelSelection("openai", "gpt-5.6", "max"), relaunched.selection("mac-a"))
        assertEquals(AidenChatModelSelection("google", "gemini-flash", null), relaunched.selection("mac-b"))
        assertNull(relaunched.selection("mac-c"))

        relaunched.purge("mac-a")
        assertNull(AidenModelPreferenceStore(tempFolder.root).selection("mac-a"))
        assertEquals("gemini-flash", AidenModelPreferenceStore(tempFolder.root).selection("mac-b")?.modelId)

        File(tempFolder.root, "model_preferences.json").writeText("{not json")
        assertNull(AidenModelPreferenceStore(tempFolder.root).selection("mac-b"))
    }

    @Test
    fun storeNeverPersistsASnapshotPastItsReadLimit() {
        val store = AidenModelPreferenceStore(tempFolder.root)
        val selection = AidenChatModelSelection("p".repeat(256), "m".repeat(256), null)
        val hostIds = (0 until 400).map { index -> "mac-$index-${"i".repeat(240)}" }
        hostIds.forEach { store.remember(it, selection) }

        val persisted = File(tempFolder.root, "model_preferences.json")
        assertTrue(persisted.length() <= 256L * 1024L)
        val relaunched = AidenModelPreferenceStore(tempFolder.root)
        assertEquals(selection, relaunched.selection(hostIds.first()))
        assertNull(relaunched.selection(hostIds.last()))
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun chatRestoresTheLastExplicitChoiceAfterRelaunchAndFallsBackWhenItDisappears() {
        val directory = tempFolder.newFolder("relaunch")
        val main = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val server = MockWebServer()
        val catalogBody = AtomicReference(fullCatalog)
        val wireJson = Json(json) { explicitNulls = false }
        // The current chat pair is valid but differs from the catalog defaults.
        val chat = workspaceChat("openai", "gpt-5.6")
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                return when {
                    path.endsWith("/models") -> MockResponse().setBody(catalogBody.get())
                    path.endsWith("/chats/${chat.id}") -> MockResponse().setBody(wireJson.encodeToString(chat))
                    else -> MockResponse().setResponseCode(404).setBody(
                        """{"error":{"code":"not_found","message":"Not found","requestId":"r","retryable":false}}"""
                    )
                }
            }
        }
        server.start()
        Dispatchers.setMain(main)
        val viewModels = ViewModelStore()
        try {
            runBlocking(main) {
                val installations = AidenInstallationStore(directory, InMemoryAidenSecureStore())
                installations.addInstallation(AidenPairingExchange(
                    instanceId = "instance-models", deviceId = "device-models",
                    endpoint = server.url("/api/aiden/v1").toString(), serverSpkiSha256 = "sha256/test",
                    credential = "synthetic", capabilities = listOf(AidenRemoteCapability.CHAT_READ)
                ), null)

                suspend fun launchChat(key: String): AidenChatViewModel {
                    val cache = AidenChatCache(directory)
                    val drafts = AidenChatDraftStore(directory)
                    val coordinator = AidenRemoteCoordinator(installations, directory, cache, drafts,
                        scope = CoroutineScope(main + Job().apply { cancel() }))
                    coordinator.refreshClient()
                    return AidenChatViewModel(chat.id, coordinator, cache, drafts, chat).also {
                        viewModels.put(key, it)
                        withTimeout(5_000) { it.catalog.first { catalog -> catalog != null } }
                    }
                }

                val first = launchChat("first")
                assertEquals("openai", first.selectedProviderId.value)
                assertEquals("gpt-5.6", first.selectedModelId.value)
                first.selectModel("openai", "gpt-5.6", "max")

                val relaunched = launchChat("relaunched")
                assertEquals("openai", relaunched.selectedProviderId.value)
                assertEquals("gpt-5.6", relaunched.selectedModelId.value)
                assertEquals("max", relaunched.selectedThinkingLevel.value)

                catalogBody.set(catalogWithoutRemembered)
                val afterRemoval = launchChat("after-removal")
                assertEquals("google", afterRemoval.selectedProviderId.value)
                assertEquals("gemini-flash", afterRemoval.selectedModelId.value)
                assertNull(afterRemoval.selectedThinkingLevel.value)
            }
        } finally {
            runBlocking(main) {
                // Chat persistence hops to IO; join so no continuation resumes after resetMain.
                val jobs = viewModels.keys().mapNotNull { viewModels.get(it)?.viewModelScope?.coroutineContext?.get(Job) }
                viewModels.clear()
                jobs.forEach { it.join() }
            }
            Dispatchers.resetMain()
            main.close()
            server.shutdown()
        }
    }
}
