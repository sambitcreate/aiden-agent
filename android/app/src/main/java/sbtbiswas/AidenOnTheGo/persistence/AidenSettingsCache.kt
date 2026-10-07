package sbtbiswas.AidenOnTheGo.persistence

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import sbtbiswas.AidenOnTheGo.models.AidenMemorySettings
import sbtbiswas.AidenOnTheGo.models.AidenProviderArtwork
import sbtbiswas.AidenOnTheGo.models.AidenReadAloudStatus
import sbtbiswas.AidenOnTheGo.models.AidenSpeechStatus
import java.io.File
import java.security.MessageDigest

/** The slice of a provider the Settings list shows; the full model catalog is not cached here. */
@Serializable
data class AidenSettingsProvider(
    val id: String,
    val label: String,
    val modelCount: Int,
    val artwork: AidenProviderArtwork? = null
)

/**
 * Last-known desktop settings for one paired installation, so Settings renders instantly
 * and refreshes in the background. A null section was never loaded for this installation.
 */
@Serializable
data class AidenSettingsSnapshot(
    val instanceId: String,
    val providers: List<AidenSettingsProvider>? = null,
    val canCreateProvider: Boolean = false,
    val memory: AidenMemorySettings? = null,
    val readAloud: AidenReadAloudStatus? = null,
    val speech: AidenSpeechStatus? = null
)

/** Per-installation disk cache for [AidenSettingsSnapshot], keyed like the other installation caches. */
class AidenSettingsCache(private val root: File) {
    private val json = Json { ignoreUnknownKeys = true }
    private val maximumBytes = 1_024 * 1_024

    private fun sha256(input: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        return digest.digest(input.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    private fun file(instanceId: String): File = File(root, "${sha256(instanceId)}.json")

    @Synchronized
    fun load(instanceId: String): AidenSettingsSnapshot? {
        val target = file(instanceId)
        if (!target.exists()) return null
        return try {
            json.decodeFromString<AidenSettingsSnapshot>(target.readText(Charsets.UTF_8))
                .takeIf { it.instanceId == instanceId }
        } catch (_: Exception) {
            null
        }
    }

    // Installations still paired, as last reported to [retainOnly]. Until the first report
    // every installation may write; afterwards a removed one can never be written back.
    private var paired: Set<String>? = null

    @Synchronized
    fun store(snapshot: AidenSettingsSnapshot) {
        if (paired?.contains(snapshot.instanceId) == false) return
        try {
            root.mkdirs()
            val bytes = json.encodeToString(snapshot).toByteArray(Charsets.UTF_8)
            if (bytes.size > maximumBytes) return
            val target = file(snapshot.instanceId)
            val temp = File(root, "${target.name}.tmp")
            temp.writeBytes(bytes)
            if (!temp.renameTo(target)) {
                target.delete()
                temp.renameTo(target)
            }
        } catch (_: Exception) {}
    }

    @Synchronized
    fun purge(instanceId: String) {
        file(instanceId).delete()
    }

    /**
     * Deletes every cached snapshot (and stray temp file) whose installation is no longer
     * paired, so removing a pairing or a revoked credential leaves no settings behind.
     */
    @Synchronized
    fun retainOnly(instanceIds: Set<String>) {
        paired = instanceIds.toSet()
        val keep = instanceIds.mapTo(HashSet()) { "${sha256(it)}.json" }
        root.listFiles()?.forEach { candidate ->
            if (candidate.name !in keep) candidate.delete()
        }
    }
}
