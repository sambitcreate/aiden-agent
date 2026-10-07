package sbtbiswas.AidenOnTheGo.persistence

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import java.io.File
import java.security.MessageDigest

/**
 * Per-installation, size-bounded disk cache for the last successful read of a screen
 * that has no dedicated cache: the Workspace list, Git review, branches and worktrees.
 * Screens render the saved snapshot at once and replace it when the paired desktop
 * answers, so a revisit or a cold launch never shows a loading state for data the
 * phone has already seen.
 *
 * Snapshots are display data only. Anything a write depends on (a Git snapshot id, a
 * revision) must come from a fresh read before it is sent. Each installation keeps at
 * most [maximumEntriesPerInstallation] snapshots, oldest written evicted first, and
 * a snapshot larger than [maximumEntryBytes] is not kept. Unpairing purges them all.
 */
class AidenReadSnapshotCache(
    private val root: File,
    private val maximumEntryBytes: Int = 2 * 1_024 * 1_024,
    private val maximumEntriesPerInstallation: Int = 64
) {
    @Serializable
    private data class Envelope(
        val instanceId: String,
        val key: String,
        val value: JsonElement
    )

    private val json = Json { ignoreUnknownKeys = true }
    private var lastStamp = 0L

    init {
        require(maximumEntryBytes > 0) { "Snapshot size limit must be positive" }
        require(maximumEntriesPerInstallation > 0) { "Snapshot count limit must be positive" }
        root.mkdirs()
    }

    @Synchronized
    fun <T> load(instanceId: String, key: String, serializer: KSerializer<T>): T? {
        val envelope = envelope(file(instanceId, key)) ?: return null
        if (envelope.instanceId != instanceId || envelope.key != key) return null
        return try {
            json.decodeFromJsonElement(serializer, envelope.value)
        } catch (_: Exception) {
            null
        }
    }

    /** Returns false when the snapshot was too large to keep or the write failed. */
    @Synchronized
    fun <T> store(instanceId: String, key: String, value: T, serializer: KSerializer<T>): Boolean {
        return try {
            val target = file(instanceId, key)
            lastStamp = maxOf(System.currentTimeMillis(), lastStamp + 1)
            val bytes = json.encodeToString(
                Envelope.serializer(),
                Envelope(instanceId, key, json.encodeToJsonElement(serializer, value))
            ).toByteArray(Charsets.UTF_8)
            if (bytes.size > maximumEntryBytes) {
                // A stale snapshot must not outlive a newer one that could not be kept.
                target.delete()
                return false
            }
            target.parentFile?.mkdirs()
            val temporary = File(target.parentFile, ".${target.name}.tmp")
            temporary.writeBytes(bytes)
            if (target.exists()) target.delete()
            if (!temporary.renameTo(target)) return false
            // A strictly increasing file time orders eviction by write without reparsing snapshots.
            target.setLastModified(lastStamp)
            evictOverflow(target.parentFile ?: return true)
            true
        } catch (_: Exception) {
            // Cache failures never block live reads.
            false
        }
    }

    @Synchronized
    fun remove(instanceId: String, key: String) {
        file(instanceId, key).delete()
    }

    @Synchronized
    fun purge(instanceId: String) {
        File(root, digest(instanceId)).deleteRecursively()
    }

    private fun evictOverflow(directory: File) {
        val entries = directory.listFiles { file -> file.isFile && file.extension == "json" } ?: return
        if (entries.size <= maximumEntriesPerInstallation) return
        entries.sortedWith(compareBy<File> { it.lastModified() }.thenBy { it.name })
            .take(entries.size - maximumEntriesPerInstallation)
            .forEach { it.delete() }
    }

    private fun envelope(file: File): Envelope? {
        if (!file.isFile || file.length() !in 1..maximumEntryBytes.toLong()) return null
        return try {
            json.decodeFromString(Envelope.serializer(), file.readText(Charsets.UTF_8))
        } catch (_: Exception) {
            null
        }
    }

    private fun file(instanceId: String, key: String): File =
        File(File(root, digest(instanceId)), "${digest(key)}.json")

    private fun digest(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }
}

/** Snapshot keys, one namespace per screen so Workspace ids cannot collide across them. */
object AidenReadSnapshotKeys {
    const val WORKSPACES = "workspaces"
    fun workspaceChats(workspaceId: String) = "workspace-chats\u0000$workspaceId"
    fun gitReview(workspaceId: String) = "git-review\u0000$workspaceId"
    fun gitBranches(workspaceId: String) = "git-branches\u0000$workspaceId"
    fun gitWorktrees(workspaceId: String) = "git-worktrees\u0000$workspaceId"
}
