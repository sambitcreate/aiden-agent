package sbtbiswas.AidenOnTheGo.features.settings

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.models.AidenMemorySettings
import sbtbiswas.AidenOnTheGo.models.AidenProviderCreation
import sbtbiswas.AidenOnTheGo.models.AidenProviderCreationReceipt
import sbtbiswas.AidenOnTheGo.models.AidenReadAloudStatus
import sbtbiswas.AidenOnTheGo.models.AidenSpeechDownload
import sbtbiswas.AidenOnTheGo.models.AidenSpeechStatus
import sbtbiswas.AidenOnTheGo.networking.AidenRemoteClient
import sbtbiswas.AidenOnTheGo.persistence.AidenSettingsCache
import sbtbiswas.AidenOnTheGo.persistence.AidenSettingsProvider
import sbtbiswas.AidenOnTheGo.persistence.AidenSettingsSnapshot
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import java.util.UUID

/** The desktop calls Settings makes. Production adapts [AidenRemoteClient]; tests supply fakes. */
interface AidenSettingsRemote {
    suspend fun canCreateProvider(): Boolean
    suspend fun providers(): List<AidenSettingsProvider>
    suspend fun createProvider(input: AidenProviderCreation, idempotencyKey: UUID): AidenProviderCreationReceipt
    suspend fun memorySettings(): AidenMemorySettings
    suspend fun updateMemorySettings(revision: String, enabled: Boolean): AidenMemorySettings
    suspend fun readAloudStatus(): AidenReadAloudStatus
    suspend fun speechStatus(): AidenSpeechStatus
    suspend fun selectSpeechModel(modelId: String): AidenSpeechStatus
    suspend fun downloadSpeechModel(modelId: String): AidenSpeechStatus
    suspend fun cancelSpeechModelDownload(modelId: String): AidenSpeechStatus
}

class AidenRemoteClientSettings(private val client: AidenRemoteClient) : AidenSettingsRemote {
    override suspend fun canCreateProvider(): Boolean {
        val server = client.server()
        return PROVIDERS_CREATE_FEATURE in server.features && AidenRemoteCapability.WORKSPACE_MANAGE in server.capabilities
    }

    override suspend fun providers(): List<AidenSettingsProvider> =
        client.modelCatalog().providers.map { AidenSettingsProvider(it.id, it.label, it.models.size, it.artwork) }

    override suspend fun createProvider(input: AidenProviderCreation, idempotencyKey: UUID) =
        client.createProvider(input, idempotencyKey)

    override suspend fun memorySettings() = client.memorySettings()
    override suspend fun updateMemorySettings(revision: String, enabled: Boolean) = client.updateMemorySettings(revision, enabled)
    override suspend fun readAloudStatus() = client.readAloudStatus()
    override suspend fun speechStatus() = client.speechStatus()
    override suspend fun selectSpeechModel(modelId: String) = client.selectSpeechModel(modelId)
    override suspend fun downloadSpeechModel(modelId: String) = client.downloadSpeechModel(modelId)
    override suspend fun cancelSpeechModelDownload(modelId: String) = client.cancelSpeechModelDownload(modelId)

    private companion object {
        const val PROVIDERS_CREATE_FEATURE = "providers-create-v1"
    }
}

/** Why a section has no fresh value. The screen maps each to its own copy. */
enum class AidenSettingsFailure { UNAVAILABLE, SAVE_FAILED }

/**
 * Everything Settings shows about the paired desktop. Values are last-known (from disk or
 * the latest response); a null value with no failure while connected is a first load.
 */
data class AidenSettingsState(
    val instanceId: String? = null,
    val isConnected: Boolean = false,
    val providers: List<AidenSettingsProvider>? = null,
    val canCreateProvider: Boolean = false,
    val providersFailure: AidenSettingsFailure? = null,
    val memory: AidenMemorySettings? = null,
    val isSavingMemory: Boolean = false,
    val memoryFailure: AidenSettingsFailure? = null,
    val readAloud: AidenReadAloudStatus? = null,
    val readAloudFailure: AidenSettingsFailure? = null,
    val speech: AidenSpeechStatus? = null,
    val speechFailure: AidenSettingsFailure? = null
) {
    val isLoadingProviders: Boolean get() = isConnected && providers == null && providersFailure == null
    val isLoadingMemory: Boolean get() = isConnected && memory == null && memoryFailure == null
    val isLoadingReadAloud: Boolean get() = isConnected && readAloud == null && readAloudFailure == null
    val isLoadingSpeech: Boolean get() = isConnected && speech == null && speechFailure == null

    internal fun snapshot(): AidenSettingsSnapshot? = instanceId?.let {
        AidenSettingsSnapshot(
            instanceId = it,
            providers = providers,
            canCreateProvider = canCreateProvider,
            memory = memory,
            readAloud = readAloud,
            speech = speech
        )
    }

    internal companion object {
        fun from(instanceId: String?, snapshot: AidenSettingsSnapshot?, connected: Boolean) = AidenSettingsState(
            instanceId = instanceId,
            isConnected = connected,
            providers = snapshot?.providers,
            canCreateProvider = snapshot?.canCreateProvider ?: false,
            memory = snapshot?.memory,
            readAloud = snapshot?.readAloud,
            speech = snapshot?.speech
        )
    }
}

/**
 * Process-lifetime owner of Settings data. It renders the cached snapshot of the active
 * installation immediately, refreshes sections in the background whenever Settings asks,
 * and applies mutations optimistically with rollback. Living outside composition means
 * rotation or returning to Settings never shows a loading state again.
 */
class AidenSettingsStore(
    private val cache: AidenSettingsCache,
    private val scope: CoroutineScope,
    private val io: CoroutineDispatcher = Dispatchers.IO
) {
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private val writer = io.limitedParallelism(1)
    private val _state = MutableStateFlow(AidenSettingsState())
    val state: StateFlow<AidenSettingsState> = _state.asStateFlow()

    private var remote: AidenSettingsRemote? = null
    private var generation = 0L
    private var refreshJob: Job? = null
    private var speechJob: Job? = null
    private var speechPollJob: Job? = null

    /** Points Settings at the active installation and its client. The same installation keeps its values. */
    fun bind(instanceId: String?, remote: AidenSettingsRemote?) {
        generation += 1
        refreshJob?.cancel()
        speechJob?.cancel()
        speechPollJob?.cancel()
        this.remote = remote
        val current = _state.value
        _state.value = if (instanceId != null && instanceId == current.instanceId) {
            current.copy(
                isConnected = remote != null,
                isSavingMemory = false,
                providersFailure = null,
                memoryFailure = null,
                readAloudFailure = null,
                speechFailure = null
            )
        } else {
            AidenSettingsState.from(instanceId, instanceId?.let(cache::load), remote != null)
        }
    }

    /** Background refresh of providers, memory, and Read Aloud. Cached values stay on screen meanwhile. */
    fun refresh() {
        val remote = remote ?: return
        if (refreshJob?.isActive == true) return
        val gen = generation
        refreshJob = scope.launch {
            val providers = launch {
                fetch(gen, { AidenProviderListing(remote.providers(), remote.canCreateProvider()) }) { state, listing ->
                    if (listing == null) state.copy(providersFailure = AidenSettingsFailure.UNAVAILABLE)
                    else state.copy(providers = listing.providers, canCreateProvider = listing.canCreate, providersFailure = null)
                }
            }
            val memory = launch {
                fetch(gen, { remote.memorySettings() }) { state, memory ->
                    when {
                        // A toggle in flight owns the visible value until it reconciles.
                        state.isSavingMemory -> state
                        memory == null -> state.copy(memoryFailure = AidenSettingsFailure.UNAVAILABLE)
                        else -> state.copy(memory = memory, memoryFailure = null)
                    }
                }
            }
            val readAloud = launch { refreshReadAloudNow(remote, gen) }
            providers.join(); memory.join(); readAloud.join()
        }
    }

    private suspend fun refreshReadAloudNow(remote: AidenSettingsRemote, gen: Long) {
        fetch(gen, { remote.readAloudStatus() }) { state, status ->
            if (status == null) state.copy(readAloudFailure = AidenSettingsFailure.UNAVAILABLE)
            else state.copy(readAloud = status, readAloudFailure = null)
        }
    }

    /** Refreshes desktop transcription status, polling while a model download is running. */
    fun refreshSpeech() {
        val remote = remote ?: return
        if (speechJob?.isActive == true) return
        val gen = generation
        speechJob = scope.launch {
            fetch(gen, { remote.speechStatus() }) { state, status ->
                if (status == null) state.copy(speechFailure = AidenSettingsFailure.UNAVAILABLE)
                else state.copy(speech = status, speechFailure = null)
            }
            pollSpeechWhileDownloading()
        }
    }

    /**
     * Optimistically flips memory, then reconciles with the desktop's answer. A failure
     * restores the previous value and reports [AidenSettingsFailure.SAVE_FAILED].
     */
    fun setMemoryEnabled(enabled: Boolean) {
        val remote = remote ?: return
        val state = _state.value
        val previous = state.memory ?: return
        if (state.isSavingMemory || previous.enabled == enabled) return
        val gen = generation
        _state.value = state.copy(memory = previous.copy(enabled = enabled), isSavingMemory = true, memoryFailure = null)
        scope.launch {
            val saved = try {
                remote.updateMemorySettings(previous.revision, enabled)
            } catch (cancelled: CancellationException) {
                if (gen == generation) _state.update { it.copy(memory = previous, isSavingMemory = false) }
                throw cancelled
            } catch (_: Exception) {
                null
            }
            if (gen != generation) return@launch
            _state.update {
                if (saved == null) it.copy(memory = previous, isSavingMemory = false, memoryFailure = AidenSettingsFailure.SAVE_FAILED)
                else it.copy(memory = saved, isSavingMemory = false, memoryFailure = null)
            }
            if (saved != null) persist()
        }
    }

    fun selectSpeechModel(modelId: String) = mutateSpeech(
        optimistic = { it.copy(selectedModelId = modelId) },
        call = { remote -> remote.selectSpeechModel(modelId) }
    )

    fun downloadSpeechModel(modelId: String) = mutateSpeech(
        optimistic = { status ->
            status.copy(models = status.models.map { model ->
                if (model.id != modelId) model
                else model.copy(download = AidenSpeechDownload(id = modelId, percentage = 0, phase = "download", status = "downloading"))
            })
        },
        call = { remote -> remote.downloadSpeechModel(modelId) }
    )

    fun cancelSpeechModelDownload(modelId: String) = mutateSpeech(
        optimistic = { status ->
            status.copy(models = status.models.map { if (it.id == modelId) it.copy(download = null) else it })
        },
        call = { remote -> remote.cancelSpeechModelDownload(modelId) }
    )

    private fun mutateSpeech(
        optimistic: (AidenSpeechStatus) -> AidenSpeechStatus,
        call: suspend (AidenSettingsRemote) -> AidenSpeechStatus
    ) {
        val remote = remote ?: return
        val previous = _state.value.speech ?: return
        val gen = generation
        _state.update { it.copy(speech = optimistic(previous), speechFailure = null) }
        scope.launch {
            val result = try {
                call(remote)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                null
            }
            if (gen != generation) return@launch
            _state.update {
                if (result == null) it.copy(speech = previous, speechFailure = AidenSettingsFailure.SAVE_FAILED)
                else it.copy(speech = result, speechFailure = null)
            }
            if (result != null) {
                persist()
                pollSpeechWhileDownloading()
            }
        }
    }

    private fun pollSpeechWhileDownloading() {
        if (speechPollJob?.isActive == true) return
        val remote = remote ?: return
        val gen = generation
        speechPollJob = scope.launch {
            while (gen == generation && _state.value.speech?.isDownloading == true) {
                delay(SPEECH_POLL_MILLIS)
                val status = try {
                    remote.speechStatus()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    break
                }
                if (gen != generation) break
                _state.update { it.copy(speech = status, speechFailure = null) }
            }
            if (gen == generation) persist()
        }
    }

    /**
     * Creates a provider on the desktop. The new provider joins the list immediately from the
     * receipt, and a background refresh reconciles it with the catalog. Throws on failure so
     * the form can keep the user's input.
     */
    suspend fun createProvider(input: AidenProviderCreation, idempotencyKey: UUID) {
        val remote = remote ?: throw IllegalStateException("Not connected")
        val gen = generation
        val receipt = remote.createProvider(input, idempotencyKey)
        if (gen != generation) return
        _state.update { state ->
            val added = AidenSettingsProvider(receipt.id, receipt.label, receipt.models.size)
            state.copy(providers = state.providers.orEmpty().filterNot { it.id == receipt.id } + added)
        }
        persist()
        refreshJob?.cancel()
        refresh()
    }

    private suspend fun <T> fetch(
        gen: Long,
        load: suspend () -> T,
        apply: (AidenSettingsState, T?) -> AidenSettingsState
    ) {
        val value = try {
            load()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            null
        }
        if (gen != generation) return
        _state.update { apply(it, value) }
        if (value != null) persist()
    }

    /** Writes the latest state, serialized on one writer so an older snapshot never lands last. */
    private fun persist() {
        scope.launch(writer) { _state.value.snapshot()?.let(cache::store) }
    }

    private data class AidenProviderListing(val providers: List<AidenSettingsProvider>, val canCreate: Boolean)

    private companion object {
        const val SPEECH_POLL_MILLIS = 1_000L
    }
}

internal val AidenSpeechStatus.isDownloading: Boolean
    get() = models.any { it.download?.status == "downloading" }
