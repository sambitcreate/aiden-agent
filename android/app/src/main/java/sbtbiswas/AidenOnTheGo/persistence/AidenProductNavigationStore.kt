package sbtbiswas.AidenOnTheGo.persistence

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File

@Serializable
enum class AidenProductArea {
    BOTS,
    WORKSPACES
}

@Serializable
private data class ProductNavigationState(
    val activeAreas: Map<String, AidenProductArea> = emptyMap(),
    val selectedWorkspaces: Map<String, String?> = emptyMap(),
    val selectedBots: Map<String, String?> = emptyMap(),
    val seenCoachmarks: Map<String, Set<String>> = emptyMap(),
    val defaultActiveArea: AidenProductArea = AidenProductArea.BOTS,
    val defaultHasSeenCoachmark: Boolean = false
)

class AidenProductNavigationStore(private val storageDir: File) {
    private val json = Json { ignoreUnknownKeys = true; prettyPrint = true }
    private val storeFile = File(storageDir, "product_navigation.json")

    private val _state = MutableStateFlow(ProductNavigationState())

    private val _activeArea = MutableStateFlow(AidenProductArea.BOTS)
    val activeArea: StateFlow<AidenProductArea> = _activeArea.asStateFlow()

    private val _hasSeenCoachmark = MutableStateFlow(false)
    val hasSeenCoachmark: StateFlow<Boolean> = _hasSeenCoachmark.asStateFlow()

    init {
        load()
    }

    @Synchronized
    private fun load() {
        if (!storeFile.exists()) return
        try {
            val state = json.decodeFromString<ProductNavigationState>(storeFile.readText(Charsets.UTF_8))
            _state.value = state
            _activeArea.value = state.defaultActiveArea
            _hasSeenCoachmark.value = state.defaultHasSeenCoachmark
        } catch (_: Exception) {}
    }

    @Synchronized
    private fun save() {
        try {
            storageDir.mkdirs()
            val state = _state.value.copy(
                defaultActiveArea = _activeArea.value,
                defaultHasSeenCoachmark = _hasSeenCoachmark.value
            )
            storeFile.writeText(json.encodeToString(state), Charsets.UTF_8)
        } catch (_: Exception) {}
    }

    fun switchArea(area: AidenProductArea) {
        _activeArea.value = area
        save()
    }

    fun markCoachmarkSeen() {
        _hasSeenCoachmark.value = true
        save()
    }

    fun selectedArea(instanceId: String): AidenProductArea =
        _state.value.activeAreas[instanceId] ?: AidenProductArea.BOTS

    fun activateSelectedArea(instanceId: String, botsAvailable: Boolean) {
        val stored = selectedArea(instanceId)
        _activeArea.value = if (stored == AidenProductArea.BOTS && !botsAvailable) {
            AidenProductArea.WORKSPACES
        } else stored
    }

    fun setSelectedArea(instanceId: String, area: AidenProductArea) {
        _state.value = _state.value.copy(
            activeAreas = _state.value.activeAreas + (instanceId to area)
        )
        _activeArea.value = area
        save()
    }

    fun selectedWorkspaceId(instanceId: String): String? =
        _state.value.selectedWorkspaces[instanceId]

    fun setSelectedWorkspaceId(instanceId: String, workspaceId: String?) {
        _state.value = _state.value.copy(
            selectedWorkspaces = _state.value.selectedWorkspaces + (instanceId to workspaceId)
        )
        save()
    }

    fun selectedBotId(instanceId: String): String? =
        _state.value.selectedBots[instanceId]

    fun setSelectedBotId(instanceId: String, botId: String?) {
        _state.value = _state.value.copy(
            selectedBots = _state.value.selectedBots + (instanceId to botId)
        )
        save()
    }

    fun hasSeenCoachmark(instanceId: String, coachmark: String): Boolean =
        _state.value.seenCoachmarks[instanceId]?.contains(coachmark) == true

    fun markCoachmarkSeen(instanceId: String, coachmark: String) {
        val current = _state.value.seenCoachmarks[instanceId] ?: emptySet()
        _state.value = _state.value.copy(
            seenCoachmarks = _state.value.seenCoachmarks + (instanceId to (current + coachmark))
        )
        _hasSeenCoachmark.value = true
        save()
    }

    fun purge(instanceId: String) {
        _state.value = _state.value.copy(
            activeAreas = _state.value.activeAreas - instanceId,
            selectedWorkspaces = _state.value.selectedWorkspaces - instanceId,
            selectedBots = _state.value.selectedBots - instanceId,
            seenCoachmarks = _state.value.seenCoachmarks - instanceId
        )
        save()
    }
}
