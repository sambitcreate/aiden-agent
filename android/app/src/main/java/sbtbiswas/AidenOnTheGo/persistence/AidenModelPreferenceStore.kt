package sbtbiswas.AidenOnTheGo.persistence

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import sbtbiswas.AidenOnTheGo.models.AidenChatModelSelection
import java.io.File

/**
 * Device-local memory of the last provider, model and thinking level the user
 * explicitly chose in a Workspace chat composer, kept separately for each
 * paired Mac. Only opaque catalog identifiers are stored — never prompts,
 * credentials or chat content — and the entry is removed with the pairing.
 *
 * The stored choice is a preference, not an authority: callers validate it
 * against the host's current model inventory before using it.
 */
class AidenModelPreferenceStore(private val storageDir: File) {
    @Serializable
    private data class Entry(
        val providerId: String,
        val modelId: String,
        val thinkingLevel: String? = null
    )

    @Serializable
    private data class Snapshot(
        val version: Int = VERSION,
        val selections: Map<String, Entry> = emptyMap()
    )

    private val json = Json { ignoreUnknownKeys = true }
    private val storeFile = File(storageDir, FILE_NAME)
    private var snapshot = Snapshot()

    init {
        load()
    }

    @Synchronized
    fun selection(instanceId: String): AidenChatModelSelection? {
        if (!isSafeId(instanceId)) return null
        val entry = snapshot.selections[instanceId] ?: return null
        return AidenChatModelSelection(entry.providerId, entry.modelId, entry.thinkingLevel)
    }

    @Synchronized
    fun remember(instanceId: String, selection: AidenChatModelSelection) {
        if (!isSafeId(instanceId)) return
        val providerId = selection.providerId?.takeIf(::isSafeId) ?: return
        val modelId = selection.modelId?.takeIf(::isSafeId) ?: return
        val thinkingLevel = selection.thinkingLevel?.takeIf(::isSafeId)
        val entry = Entry(providerId, modelId, thinkingLevel)
        if (snapshot.selections[instanceId] == entry) return
        save(snapshot.copy(selections = snapshot.selections + (instanceId to entry)))
    }

    @Synchronized
    fun purge(instanceId: String) {
        if (!snapshot.selections.containsKey(instanceId)) return
        save(snapshot.copy(selections = snapshot.selections - instanceId))
    }

    private fun load() {
        if (!storeFile.exists() || storeFile.length() > MAXIMUM_BYTES) return
        val decoded = try {
            json.decodeFromString<Snapshot>(storeFile.readText(Charsets.UTF_8))
        } catch (_: Exception) {
            return
        }
        if (decoded.version != VERSION) return
        snapshot = Snapshot(
            selections = decoded.selections.filter { (instanceId, entry) ->
                isSafeId(instanceId) && isSafeId(entry.providerId) && isSafeId(entry.modelId) &&
                    (entry.thinkingLevel == null || isSafeId(entry.thinkingLevel))
            }
        )
    }

    private fun save(next: Snapshot) {
        val encoded = runCatching { json.encodeToString(next) }.getOrNull() ?: return
        if (encoded.toByteArray(Charsets.UTF_8).size > MAXIMUM_BYTES) return
        try {
            storageDir.mkdirs()
            val temporary = File(storageDir, "$FILE_NAME.tmp")
            temporary.writeText(encoded, Charsets.UTF_8)
            if (!temporary.renameTo(storeFile)) {
                storeFile.writeText(encoded, Charsets.UTF_8)
                temporary.delete()
            }
            snapshot = next
        } catch (_: Exception) {}
    }

    private fun isSafeId(value: String): Boolean =
        value.isNotEmpty() && value.length <= MAXIMUM_ID_LENGTH && value.none { it.isISOControl() }

    private companion object {
        const val VERSION = 1
        const val FILE_NAME = "model_preferences.json"
        const val MAXIMUM_ID_LENGTH = 256
        const val MAXIMUM_BYTES = 256L * 1024L
    }
}
