package sbtbiswas.AidenOnTheGo.features.settings

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import sbtbiswas.AidenOnTheGo.models.AidenMemorySettings
import sbtbiswas.AidenOnTheGo.models.AidenProviderCreation
import sbtbiswas.AidenOnTheGo.models.AidenProviderCreationModel
import sbtbiswas.AidenOnTheGo.models.AidenProviderCreationReceipt
import sbtbiswas.AidenOnTheGo.models.AidenReadAloudStatus
import sbtbiswas.AidenOnTheGo.models.AidenSpeechEngine
import sbtbiswas.AidenOnTheGo.models.AidenSpeechInputContract
import sbtbiswas.AidenOnTheGo.models.AidenSpeechModel
import sbtbiswas.AidenOnTheGo.models.AidenSpeechStatus
import sbtbiswas.AidenOnTheGo.persistence.AidenSettingsCache
import sbtbiswas.AidenOnTheGo.persistence.AidenSettingsProvider
import sbtbiswas.AidenOnTheGo.persistence.AidenSettingsSnapshot
import java.io.IOException
import java.util.UUID

@OptIn(ExperimentalCoroutinesApi::class)
class AidenSettingsStoreTest {
    @get:Rule
    val tempFolder = TemporaryFolder()

    private class FakeRemote : AidenSettingsRemote {
        var providers = listOf(AidenSettingsProvider("openai", "OpenAI", 3))
        var memory = AidenMemorySettings(enabled = true, revision = "r1")
        var memoryGate: CompletableDeferred<Unit>? = null
        var failMemoryUpdate = false
        var failReads = false
        val memoryUpdates = mutableListOf<Pair<String, Boolean>>()
        var speech = speechStatus(selected = "small")

        private fun read() { if (failReads) throw IOException("offline") }

        override suspend fun canCreateProvider(): Boolean { read(); return true }
        override suspend fun providers(): List<AidenSettingsProvider> { read(); return providers }
        override suspend fun createProvider(input: AidenProviderCreation, idempotencyKey: UUID) =
            AidenProviderCreationReceipt("custom:remote-1", input.label, input.models.map { it.id })
        override suspend fun memorySettings(): AidenMemorySettings { read(); return memory }
        override suspend fun updateMemorySettings(revision: String, enabled: Boolean): AidenMemorySettings {
            memoryUpdates += revision to enabled
            memoryGate?.await()
            if (failMemoryUpdate) throw IOException("conflict")
            memory = AidenMemorySettings(enabled, "r2")
            return memory
        }
        override suspend fun readAloudStatus(): AidenReadAloudStatus { read(); return AidenReadAloudStatus(true, true, "t1") }
        override suspend fun speechStatus(): AidenSpeechStatus { read(); return speech }
        override suspend fun selectSpeechModel(modelId: String): AidenSpeechStatus { read(); speech = speechStatus(modelId); return speech }
        override suspend fun downloadSpeechModel(modelId: String): AidenSpeechStatus = throw IOException("disk full")
        override suspend fun cancelSpeechModelDownload(modelId: String): AidenSpeechStatus = speech
    }

    private fun TestScope.store(cache: AidenSettingsCache = AidenSettingsCache(tempFolder.root)) =
        AidenSettingsStore(cache, this, io = StandardTestDispatcher(testScheduler))

    @Test
    fun cachedSettingsAreVisibleImmediatelyAndThenRefreshed() = runTest {
        val cache = AidenSettingsCache(tempFolder.root)
        cache.store(
            AidenSettingsSnapshot(
                instanceId = "mac",
                providers = listOf(AidenSettingsProvider("old", "Old provider", 1)),
                memory = AidenMemorySettings(enabled = false, revision = "r0")
            )
        )
        val store = store(cache)
        val remote = FakeRemote()

        store.bind("mac", remote)
        val cached = store.state.value
        assertEquals(listOf("Old provider"), cached.providers?.map { it.label })
        assertEquals(false, cached.memory?.enabled)
        assertFalse("cached values never show the first-load state", cached.isLoadingProviders || cached.isLoadingMemory)

        store.refresh()
        advanceUntilIdle()

        assertEquals(listOf("OpenAI"), store.state.value.providers?.map { it.label })
        assertEquals(true, store.state.value.memory?.enabled)
        assertEquals("the refreshed values replace the cache", listOf("OpenAI"), cache.load("mac")?.providers?.map { it.label })
    }

    @Test
    fun aReconnectDuringAnUnconfirmedMemoryChangeRestoresTheConfirmedValue() = runTest {
        val store = store()
        val remote = FakeRemote()
        store.bind("mac", remote)
        store.refresh()
        advanceUntilIdle()
        assertEquals(true, store.state.value.memory?.enabled)

        remote.memoryGate = CompletableDeferred()
        remote.failMemoryUpdate = true
        store.setMemoryEnabled(false)
        runCurrent()
        assertEquals("optimistic value shows at once", false, store.state.value.memory?.enabled)

        // The client reconnects to the same desktop while the change is still in flight.
        store.bind("mac", FakeRemote().apply { failReads = true })
        remote.memoryGate?.complete(Unit)
        advanceUntilIdle()

        assertEquals("the desktop never confirmed the change", true, store.state.value.memory?.enabled)
        assertFalse(store.state.value.isSavingMemory)
    }

    @Test
    fun aReconnectDuringAnUnconfirmedSpeechChangeRestoresTheConfirmedStatus() = runTest {
        val store = store()
        val remote = FakeRemote()
        store.bind("mac", remote)
        store.refreshSpeech()
        advanceUntilIdle()
        val confirmed = store.state.value.speech
        assertEquals("small", confirmed?.selectedModelId)

        store.downloadSpeechModel("large")
        store.bind("mac", FakeRemote().apply { failReads = true })
        advanceUntilIdle()

        assertEquals(confirmed, store.state.value.speech)
    }

    @Test
    fun aFailedRefreshKeepsTheLastKnownValues() = runTest {
        val store = store()
        val remote = FakeRemote()
        store.bind("mac", remote)
        store.refresh()
        advanceUntilIdle()

        remote.failReads = true
        store.refresh()
        advanceUntilIdle()

        val state = store.state.value
        assertEquals(listOf("OpenAI"), state.providers?.map { it.label })
        assertEquals(AidenSettingsFailure.UNAVAILABLE, state.providersFailure)
        assertEquals(true, state.memory?.enabled)
    }

    @Test
    fun aFirstLoadWithNothingCachedIsReportedAsLoadingOnlyWhileConnected() = runTest {
        val store = store()
        store.bind("mac", null)
        assertFalse(store.state.value.isLoadingProviders)

        store.bind("mac", FakeRemote())
        assertTrue(store.state.value.isLoadingProviders)
        assertTrue(store.state.value.isLoadingMemory)
    }

    @Test
    fun memoryToggleIsOptimisticAndReconcilesWithTheDesktop() = runTest {
        val store = store()
        val remote = FakeRemote().apply { memoryGate = CompletableDeferred() }
        store.bind("mac", remote)
        store.refresh()
        advanceUntilIdle()

        store.setMemoryEnabled(false)
        runCurrent()
        assertEquals("the switch moves before the desktop answers", false, store.state.value.memory?.enabled)
        assertTrue(store.state.value.isSavingMemory)

        remote.memoryGate!!.complete(Unit)
        advanceUntilIdle()

        assertEquals(AidenMemorySettings(enabled = false, revision = "r2"), store.state.value.memory)
        assertEquals(listOf("r1" to false), remote.memoryUpdates)
        assertNull(store.state.value.memoryFailure)
    }

    @Test
    fun aRejectedMemoryToggleRollsBackWithAnError() = runTest {
        val store = store()
        val remote = FakeRemote().apply { failMemoryUpdate = true }
        store.bind("mac", remote)
        store.refresh()
        advanceUntilIdle()

        store.setMemoryEnabled(false)
        advanceUntilIdle()

        assertEquals(AidenMemorySettings(enabled = true, revision = "r1"), store.state.value.memory)
        assertEquals(AidenSettingsFailure.SAVE_FAILED, store.state.value.memoryFailure)
        assertFalse(store.state.value.isSavingMemory)
    }

    @Test
    fun aFailedSpeechActionRestoresThePreviousStatus() = runTest {
        val store = store()
        val remote = FakeRemote()
        store.bind("mac", remote)
        store.refreshSpeech()
        advanceUntilIdle()
        val before = store.state.value.speech

        store.downloadSpeechModel("large")
        assertTrue("the download shows as started before the desktop answers", store.state.value.speech!!.isDownloading)
        advanceUntilIdle()

        assertEquals(before, store.state.value.speech)
        assertEquals(AidenSettingsFailure.SAVE_FAILED, store.state.value.speechFailure)
    }

    @Test
    fun aCreatedProviderJoinsTheListBeforeTheCatalogRefreshes() = runTest {
        val store = store()
        val remote = FakeRemote()
        store.bind("mac", remote)
        store.refresh()
        advanceUntilIdle()
        remote.failReads = true

        store.createProvider(
            AidenProviderCreation(label = "Local", baseUrl = "http://mac.local:1234", needsKey = false,
                models = listOf(AidenProviderCreationModel("qwen"))),
            UUID.randomUUID()
        )
        advanceUntilIdle()

        assertEquals(listOf("OpenAI", "Local"), store.state.value.providers?.map { it.label })
    }

    @Test
    fun switchingInstallationsShowsThatInstallationsOwnCache() = runTest {
        val cache = AidenSettingsCache(tempFolder.root)
        cache.store(AidenSettingsSnapshot("mac-2", providers = listOf(AidenSettingsProvider("x", "Mac 2 provider", 1))))
        val store = store(cache)
        store.bind("mac-1", FakeRemote())
        store.refresh()
        advanceUntilIdle()

        store.bind("mac-2", FakeRemote().apply { failReads = true })

        assertEquals(listOf("Mac 2 provider"), store.state.value.providers?.map { it.label })
        assertNull(store.state.value.memory)
    }

    private companion object {
        fun speechStatus(selected: String?) = AidenSpeechStatus(
            engine = AidenSpeechEngine(ready = true),
            selectedModelId = selected,
            models = listOf(
                AidenSpeechModel("small", "Small", "Fast", "100 MB", "English", recommended = true, installed = true),
                AidenSpeechModel("large", "Large", "Accurate", "1 GB", "25 languages", recommended = false, installed = false)
            ),
            input = AidenSpeechInputContract("pcm_s16le", 16_000, 1, 60, false)
        )
    }
}
