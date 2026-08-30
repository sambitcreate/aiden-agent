package sbtbiswas.AidenOnTheGo.persistence

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceFileDocument
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceFileEntry
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceFileIndex
import sbtbiswas.AidenOnTheGo.models.AidenWorkspaceFileKind
import sbtbiswas.AidenOnTheGo.protocol.InstantIso8601Serializer
import java.io.File
import java.security.MessageDigest
import java.time.Instant

class AidenWorkspaceEnvironmentCache(private val directory: File) {
    @Serializable
    data class Snapshot(
        val index: AidenWorkspaceFileIndex,
        val documents: Map<String, AidenWorkspaceFileDocument> = emptyMap(),
        @Serializable(with = InstantIso8601Serializer::class) val updatedAt: Instant = Instant.now()
    )

    private val json = Json { ignoreUnknownKeys = true; prettyPrint = true }
    private val maximumBytes = 8 * 1_048_576

    init {
        directory.mkdirs()
    }

    private fun sha256(input: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val bytes = digest.digest(input.toByteArray(Charsets.UTF_8))
        return bytes.joinToString("") { "%02x".format(it) }
    }

    private fun instanceDigest(instanceId: String): String = sha256(instanceId)

    private fun file(instanceId: String, workspaceId: String): File {
        val instDir = File(directory, instanceDigest(instanceId))
        return File(instDir, "${sha256(workspaceId)}.json")
    }

    private fun legacyFile(instanceId: String, workspaceId: String): File {
        val digest = sha256("$instanceId\u0000$workspaceId")
        return File(directory, "$digest.json")
    }

    @Synchronized
    fun load(instanceId: String, workspaceId: String): Snapshot? {
        val currentFile = file(instanceId, workspaceId)
        if (currentFile.exists()) {
            try {
                return json.decodeFromString<Snapshot>(currentFile.readText(Charsets.UTF_8))
            } catch (_: Exception) {}
        }
        val legacy = legacyFile(instanceId, workspaceId)
        if (legacy.exists()) {
            try {
                val snapshot = json.decodeFromString<Snapshot>(legacy.readText(Charsets.UTF_8))
                persist(snapshot, instanceId, workspaceId)
                legacy.delete()
                return snapshot
            } catch (_: Exception) {}
        }
        return null
    }

    @Synchronized
    fun store(index: AidenWorkspaceFileIndex, instanceId: String, workspaceId: String) {
        val retained = load(instanceId, workspaceId)?.documents ?: emptyMap()
        val validIds = index.entries.filter { it.kind == AidenWorkspaceFileKind.FILE }.map { it.id }.toSet()
        val filteredDocs = retained.filter { validIds.contains(it.key) }
        persist(
            Snapshot(
                index = index,
                documents = filteredDocs,
                updatedAt = Instant.now()
            ),
            instanceId = instanceId,
            workspaceId = workspaceId
        )
    }

    @Synchronized
    fun store(document: AidenWorkspaceFileDocument, instanceId: String, workspaceId: String) {
        val snapshot = load(instanceId, workspaceId) ?: return
        val map = snapshot.documents.toMutableMap()
        map[document.id] = document
        val updated = snapshot.copy(documents = map, updatedAt = Instant.now())
        persist(updated, instanceId, workspaceId)
    }

    @Synchronized
    fun purge(instanceId: String, knownWorkspaceIds: Set<String> = emptySet()) {
        val instDir = File(directory, instanceDigest(instanceId))
        instDir.deleteRecursively()
        for (workspaceId in knownWorkspaceIds) {
            val legacy = legacyFile(instanceId, workspaceId)
            if (legacy.exists()) {
                legacy.delete()
            }
        }
    }

    @Synchronized
    private fun persist(snapshot: Snapshot, instanceId: String, workspaceId: String) {
        try {
            val targetFile = file(instanceId, workspaceId)
            targetFile.parentFile?.mkdirs()
            var value = snapshot
            var text = json.encodeToString(value)
            var bytes = text.toByteArray(Charsets.UTF_8)
            if (bytes.size > maximumBytes) {
                value = value.copy(documents = emptyMap())
                text = json.encodeToString(value)
                bytes = text.toByteArray(Charsets.UTF_8)
            }
            if (bytes.size <= maximumBytes) {
                val tempFile = File(targetFile.parentFile, "${targetFile.name}.tmp")
                tempFile.writeBytes(bytes)
                if (targetFile.exists()) targetFile.delete()
                tempFile.renameTo(targetFile)
            }
        } catch (_: Exception) {}
    }
}
