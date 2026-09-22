package sbtbiswas.AidenOnTheGo.persistence

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File

class AidenWorkspaceArchiveStore(private val storageDir: File) {
    @Serializable
    private data class Snapshot(
        val workspaceIDsByInstance: Map<String, List<String>> = emptyMap(),
        val hasAcknowledgedDeviceOnlyArchive: Boolean = false
    )

    private val json = Json { ignoreUnknownKeys = true; prettyPrint = true }
    private val storeFile = File(storageDir, "device_archived_workspaces.json")

    private val _workspaceIDsByInstance = MutableStateFlow<Map<String, Set<String>>>(emptyMap())
    val workspaceIDsByInstance: StateFlow<Map<String, Set<String>>> = _workspaceIDsByInstance.asStateFlow()

    private val _hasAcknowledgedDeviceOnlyArchive = MutableStateFlow(false)
    val hasAcknowledgedDeviceOnlyArchive: StateFlow<Boolean> = _hasAcknowledgedDeviceOnlyArchive.asStateFlow()

    init {
        load()
    }

    @Synchronized
    private fun load() {
        if (!storeFile.exists()) return
        try {
            val content = storeFile.readText(Charsets.UTF_8)
            val snapshot = json.decodeFromString<Snapshot>(content)
            _workspaceIDsByInstance.value = snapshot.workspaceIDsByInstance.mapValues { entry ->
                entry.value.filter { it.isNotEmpty() }.toSet()
            }
            _hasAcknowledgedDeviceOnlyArchive.value = snapshot.hasAcknowledgedDeviceOnlyArchive
        } catch (_: Exception) {}
    }

    @Synchronized
    private fun persist() {
        try {
            storageDir.mkdirs()
            val snapshot = Snapshot(
                workspaceIDsByInstance = _workspaceIDsByInstance.value.mapValues { it.value.toList().sorted() },
                hasAcknowledgedDeviceOnlyArchive = _hasAcknowledgedDeviceOnlyArchive.value
            )
            storeFile.writeText(json.encodeToString(snapshot), Charsets.UTF_8)
        } catch (_: Exception) {}
    }

    @Synchronized
    fun archivedWorkspaceIDs(instanceId: String?): Set<String> {
        if (instanceId.isNullOrEmpty()) return emptySet()
        return _workspaceIDsByInstance.value[instanceId] ?: emptySet()
    }

    @Synchronized
    fun isArchived(workspaceId: String, instanceId: String?): Boolean {
        return archivedWorkspaceIDs(instanceId).contains(workspaceId)
    }

    @Synchronized
    fun acknowledgeDeviceOnlyArchive() {
        if (_hasAcknowledgedDeviceOnlyArchive.value) return
        _hasAcknowledgedDeviceOnlyArchive.value = true
        persist()
    }

    @Synchronized
    fun archive(workspaceId: String, instanceId: String?) {
        if (instanceId.isNullOrEmpty() || workspaceId.isEmpty()) return
        val map = _workspaceIDsByInstance.value.toMutableMap()
        val set = (map[instanceId] ?: emptySet()).toMutableSet()
        if (set.add(workspaceId)) {
            map[instanceId] = set
            _workspaceIDsByInstance.value = map
            persist()
        }
    }

    @Synchronized
    fun unarchive(workspaceId: String, instanceId: String?) {
        if (instanceId.isNullOrEmpty() || workspaceId.isEmpty()) return
        val map = _workspaceIDsByInstance.value.toMutableMap()
        val set = (map[instanceId] ?: emptySet()).toMutableSet()
        if (set.remove(workspaceId)) {
            if (set.isEmpty()) {
                map.remove(instanceId)
            } else {
                map[instanceId] = set
            }
            _workspaceIDsByInstance.value = map
            persist()
        }
    }

    @Synchronized
    fun forget(workspaceId: String, instanceId: String?) {
        unarchive(workspaceId, instanceId)
    }

    @Synchronized
    fun purge(instanceId: String) {
        val map = _workspaceIDsByInstance.value.toMutableMap()
        if (map.remove(instanceId) != null) {
            _workspaceIDsByInstance.value = map
            persist()
        }
    }

    @Synchronized
    fun prune(instanceId: String?, validWorkspaceIDs: Set<String>) {
        if (instanceId.isNullOrEmpty()) return
        val current = _workspaceIDsByInstance.value[instanceId] ?: return
        val pruned = current.intersect(validWorkspaceIDs)
        if (pruned != current) {
            val map = _workspaceIDsByInstance.value.toMutableMap()
            if (pruned.isEmpty()) {
                map.remove(instanceId)
            } else {
                map[instanceId] = pruned
            }
            _workspaceIDsByInstance.value = map
            persist()
        }
    }
}
