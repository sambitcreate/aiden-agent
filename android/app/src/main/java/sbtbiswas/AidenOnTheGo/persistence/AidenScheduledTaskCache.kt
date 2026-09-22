package sbtbiswas.AidenOnTheGo.persistence

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import sbtbiswas.AidenOnTheGo.models.AidenScheduledRun
import sbtbiswas.AidenOnTheGo.models.AidenScheduledSettings
import sbtbiswas.AidenOnTheGo.models.AidenScheduledTask
import java.io.File
import java.security.MessageDigest

class AidenScheduledTaskCache(private val root: File) {
    @Serializable
    data class Snapshot(
        val instanceId: String,
        val tasks: List<AidenScheduledTask> = emptyList(),
        val settings: AidenScheduledSettings? = null,
        val runs: Map<String, List<AidenScheduledRun>> = emptyMap()
    )

    private val json = Json { ignoreUnknownKeys = true; prettyPrint = true }
    private val maximumBytes = 10 * 1_024 * 1_024

    init {
        root.mkdirs()
    }

    private fun sha256(input: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val bytes = digest.digest(input.toByteArray(Charsets.UTF_8))
        return bytes.joinToString("") { "%02x".format(it) }
    }

    private fun file(instanceId: String): File {
        return File(root, "${sha256(instanceId)}.json")
    }

    @Synchronized
    fun load(instanceId: String): Snapshot? {
        val targetFile = file(instanceId)
        if (!targetFile.exists()) return null
        try {
            val content = targetFile.readText(Charsets.UTF_8)
            val snapshot = json.decodeFromString<Snapshot>(content)
            if (snapshot.instanceId == instanceId) {
                return snapshot
            }
        } catch (_: Exception) {}
        return null
    }

    @Synchronized
    fun loadForScheduleReadAccess(instanceId: String, canRead: Boolean): Snapshot? {
        if (!canRead) {
            purge(instanceId)
            return null
        }
        return load(instanceId)
    }

    @Synchronized
    fun store(
        instanceId: String,
        tasks: List<AidenScheduledTask>,
        settings: AidenScheduledSettings?
    ) {
        val retainedTaskIds = tasks.map { it.id }.toSet()
        val currentRuns = load(instanceId)?.runs ?: emptyMap()
        val retainedRuns = currentRuns.filter { retainedTaskIds.contains(it.key) }
        persist(Snapshot(instanceId = instanceId, tasks = tasks, settings = settings, runs = retainedRuns))
    }

    @Synchronized
    fun store(runs: List<AidenScheduledRun>, taskId: String, instanceId: String) {
        val snapshot = load(instanceId) ?: return
        if (!snapshot.tasks.any { it.id == taskId }) return
        val runsMap = snapshot.runs.toMutableMap()
        runsMap[taskId] = runs.take(50)
        persist(snapshot.copy(runs = runsMap))
    }

    @Synchronized
    fun purge(instanceId: String) {
        val targetFile = file(instanceId)
        if (targetFile.exists()) {
            targetFile.delete()
        }
    }

    @Synchronized
    private fun persist(snapshot: Snapshot) {
        try {
            val targetFile = file(snapshot.instanceId)
            targetFile.parentFile?.mkdirs()
            val text = json.encodeToString(snapshot)
            val bytes = text.toByteArray(Charsets.UTF_8)
            if (bytes.size <= maximumBytes) {
                val tempFile = File(targetFile.parentFile, "${targetFile.name}.tmp")
                tempFile.writeBytes(bytes)
                if (targetFile.exists()) targetFile.delete()
                tempFile.renameTo(targetFile)
            }
        } catch (_: Exception) {}
    }
}
