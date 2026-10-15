package sbtbiswas.AidenOnTheGo.features.settings

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import sbtbiswas.AidenOnTheGo.auth.AidenSecureStore
import sbtbiswas.AidenOnTheGo.models.AidenMemorySettings
import sbtbiswas.AidenOnTheGo.models.AidenProviderCreation
import sbtbiswas.AidenOnTheGo.models.AidenProviderCreationReceipt
import sbtbiswas.AidenOnTheGo.models.AidenReadAloudStatus
import sbtbiswas.AidenOnTheGo.models.AidenSpeechStatus
import sbtbiswas.AidenOnTheGo.persistence.AidenSettingsProvider
import java.io.IOException
import java.util.UUID

/**
 * Desktop stand-in for Settings UI tests. With [hangReads] every read suspends forever, so a
 * screen can only show what the cache gave it.
 */
internal class FakeSettingsRemote(
    var memory: AidenMemorySettings = AidenMemorySettings(enabled = true, revision = "r1"),
    var providers: List<AidenSettingsProvider> = listOf(AidenSettingsProvider("openai", "OpenAI", 3)),
    private val hangReads: Boolean = false
) : AidenSettingsRemote {
    var memoryGate: CompletableDeferred<Unit>? = null
    var rejectMemoryUpdates = false
    val memoryUpdates = mutableListOf<Boolean>()

    private suspend fun <T> read(value: () -> T): T {
        if (hangReads) awaitCancellation()
        return value()
    }

    override suspend fun canCreateProvider() = read { true }
    override suspend fun providers() = read { providers }
    override suspend fun createProvider(input: AidenProviderCreation, idempotencyKey: UUID) =
        AidenProviderCreationReceipt("custom:remote-1", input.label, input.models.map { it.id })
    override suspend fun memorySettings() = read { memory }
    override suspend fun updateMemorySettings(revision: String, enabled: Boolean): AidenMemorySettings {
        memoryUpdates += enabled
        memoryGate?.await()
        if (rejectMemoryUpdates) throw IOException("revision conflict")
        memory = AidenMemorySettings(enabled, "r2")
        return memory
    }
    override suspend fun readAloudStatus() = read { AidenReadAloudStatus(enabled = true, ready = true, settingsRevision = "t1") }
    override suspend fun speechStatus(): AidenSpeechStatus = read { throw IOException("no speech in this test") }
    override suspend fun selectSpeechModel(modelId: String): AidenSpeechStatus = throw IOException("unused")
    override suspend fun downloadSpeechModel(modelId: String): AidenSpeechStatus = throw IOException("unused")
    override suspend fun cancelSpeechModelDownload(modelId: String): AidenSpeechStatus = throw IOException("unused")
}

internal class InMemorySecureStore : AidenSecureStore {
    private val values = mutableMapOf<String, String>()
    override fun getCredential(scope: String) = values[scope]
    override fun setCredential(scope: String, credential: String) { values[scope] = credential }
    override fun removeCredential(scope: String) { values.remove(scope) }
    override fun clearAll() = values.clear()
}
