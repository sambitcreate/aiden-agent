package sbtbiswas.AidenOnTheGo

import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.Assert.*
import org.junit.Test
import sbtbiswas.AidenOnTheGo.auth.InMemoryAidenSecureStore
import sbtbiswas.AidenOnTheGo.features.chat.AidenChatViewModel
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.models.AidenChat
import sbtbiswas.AidenOnTheGo.persistence.*
import java.nio.file.Files
import java.time.Instant

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class AidenArchivedSendTest {
    @Test fun archivedSendReportsRestoreBeforeConsumingDraftOrCreatingOptimisticMessage() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        val directory = Files.createTempDirectory("aiden-archived-send").toFile()
        val models = ViewModelStore()
        try {
            val cache = AidenChatCache(directory)
            val drafts = AidenChatDraftStore(directory)
            val coordinator = AidenRemoteCoordinator(
                installationStore = AidenInstallationStore(directory, InMemoryAidenSecureStore()), storageDir = directory,
                chatCache = cache, draftStore = drafts, navigationStore = AidenProductNavigationStore(directory),
                scope = CoroutineScope(Dispatchers.Unconfined + Job().apply { cancel() })
            )
            val now = Instant.parse("2026-01-01T00:00:00Z")
            val chat = AidenChat("archived", "workspace", title = "Archived", messages = emptyList(), createdAt = now, updatedAt = now, revision = "r1", archivedAt = now)
            val model = AidenChatViewModel(chat.id, coordinator, cache, drafts, chat)
            models.put("chat", model)
            model.updateDraft("Keep this unsent draft")
            model.send()
            assertEquals("Keep this unsent draft", model.draft.value)
            assertTrue(model.chat.value!!.messages.isEmpty())
            assertFalse(model.canSend)
            assertTrue(model.presentedError.value!!.startsWith("Restore this archived chat"))
        } finally { models.clear(); directory.deleteRecursively(); Dispatchers.resetMain() }
    }
}
