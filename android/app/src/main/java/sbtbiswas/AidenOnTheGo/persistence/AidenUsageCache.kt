package sbtbiswas.AidenOnTheGo.persistence

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import sbtbiswas.AidenOnTheGo.models.AidenUsageSummary
import java.io.File
import java.security.MessageDigest

/** A small, installation-scoped warm cache for the privacy-safe 30-day usage summary. */
class AidenUsageCache(private val root: File) {
    @Serializable
    private data class Snapshot(
        val instanceId: String,
        val range: String,
        val summary: AidenUsageSummary
    )

    private val json = Json { ignoreUnknownKeys = true; prettyPrint = true }
    private val maximumBytes = 2 * 1_024 * 1_024

    init {
        root.mkdirs()
    }

    private fun file(instanceId: String, range: String): File {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest("$instanceId\n$range".toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        return File(root, "$digest.json")
    }

    @Synchronized
    fun load(instanceId: String, range: String = "30d"): AidenUsageSummary? {
        val target = file(instanceId, range)
        if (!target.exists() || target.length() !in 1..maximumBytes.toLong()) return null
        return try {
            val snapshot = json.decodeFromString<Snapshot>(target.readText(Charsets.UTF_8))
            snapshot.summary.takeIf {
                snapshot.instanceId == instanceId && snapshot.range == range && it.range == range
            }
        } catch (_: Exception) {
            null
        }
    }

    @Synchronized
    fun store(instanceId: String, summary: AidenUsageSummary) {
        try {
            val target = file(instanceId, summary.range)
            val bytes = json.encodeToString(
                Snapshot(instanceId = instanceId, range = summary.range, summary = summary)
            ).toByteArray(Charsets.UTF_8)
            if (bytes.size > maximumBytes) return
            val temporary = File(target.parentFile, "${target.name}.tmp")
            temporary.writeBytes(bytes)
            if (target.exists()) target.delete()
            temporary.renameTo(target)
        } catch (_: Exception) {
            // Cache failures never block live usage.
        }
    }
}
