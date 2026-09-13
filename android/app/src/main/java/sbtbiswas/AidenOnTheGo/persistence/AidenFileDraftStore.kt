package sbtbiswas.AidenOnTheGo.persistence

import java.io.File
import java.security.MessageDigest
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** Private app storage; stores recovery text/version, never reusable server file handles. */
class AidenFileDraftStore(private val root: File) {
    @Serializable
    data class Draft(val path: String, val original: String, val version: String, val text: String)
    companion object {
        private val generations = java.util.concurrent.ConcurrentHashMap<String, Long>()
    }
    private fun hash(value: String) = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
    private fun directory(instance: String) = File(root, hash(instance))
    private fun file(instance: String, workspace: String) = File(directory(instance), hash(workspace) + ".json")
    fun generation(instance: String) = generations[root.absolutePath + ":" + instance] ?: 0L
    fun purge(instance: String) {
        synchronized(generations) {
            generations[root.absolutePath + ":" + instance] = generation(instance) + 1L
            directory(instance).deleteRecursively()
        }
    }
    fun load(instance: String, workspace: String): Draft? = runCatching {
        val file = file(instance, workspace)
        if (!file.exists() || file.length() > 2_000_000) return null
        Json.decodeFromString<Draft>(file.readText())
    }.getOrNull()
    fun save(instance: String, workspace: String, draft: Draft?, expectedGeneration: Long = generation(instance)): Boolean = synchronized(generations) { runCatching {
        check(generation(instance) == expectedGeneration)
        directory(instance).mkdirs()
        val file = file(instance, workspace)
        if (draft == null) { if (file.exists()) check(file.delete()); return@synchronized true }
        val content = Json.encodeToString(draft)
        check(content.toByteArray().size <= 2_000_000)
        val temporary = File(file.path + ".tmp")
        temporary.writeText(content)
        Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        true
    }.getOrDefault(false) }
}
