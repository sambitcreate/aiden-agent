package sbtbiswas.AidenOnTheGo.models

import kotlinx.coroutines.ensureActive

import kotlinx.serialization.*
import kotlinx.serialization.descriptors.*
import kotlinx.serialization.encoding.*
import kotlinx.serialization.json.*

private val controlIds = setOf("appearance.mode", "appearance.chatWidth", "appearance.reduceMotion", "appearance.terminalTheme", "memory.enabled", "memory.workspace", "webSearch.enabled", "skills.enabled")
private fun token(value: String) = value.matches(Regex("^[A-Za-z0-9_-]{1,128}$"))
private fun safeValue(value: JsonPrimitive) = value.booleanOrNull != null || (value.isString && value.content.length <= 80)

@Serializable
data class AidenAppControlPanel(val version: Int, val id: String, val topic: String, val fallback: String, val workspaceId: String? = null) {
    val isWireSafe get() = version == 1 && token(id) && topic in setOf("appearance", "memory", "web-search", "skills") && fallback.length <= 500 && (workspaceId == null || token(workspaceId))
}
// Malformed additive panels must not make the ordinary conversation undecodable.
object AidenAppPanelsSerializer : KSerializer<List<AidenAppControlPanel>?> {
    override val descriptor = JsonElement.serializer().descriptor
    override fun deserialize(decoder: Decoder): List<AidenAppControlPanel>? {
        val input = decoder as JsonDecoder
        val element = input.decodeJsonElement()
        return runCatching { input.json.decodeFromJsonElement<List<AidenAppControlPanel>>(element) }.getOrNull()
            ?.takeIf { it.size <= 4 && it.all { panel -> panel.isWireSafe } && it.map { panel -> panel.id }.distinct().size == it.size }
    }
    override fun serialize(encoder: Encoder, value: List<AidenAppControlPanel>?) {
        val output = encoder as JsonEncoder
        output.encodeJsonElement(value?.let { output.json.encodeToJsonElement(it) } ?: JsonNull)
    }
}
@Serializable data class AidenAppControlOption(val value: String, val label: String)
@Serializable data class AidenAppControlRow(val id: String, val label: String, val description: String, val scope: String, val value: JsonPrimitive, val revision: String, val options: List<AidenAppControlOption>? = null, val disabledReason: String? = null) {
    val isWireSafe get() = id in controlIds && token(revision) && label.isNotEmpty() && label.length <= 120 && description.length <= 500 && scope.length <= 256 && safeValue(value) && (disabledReason?.length ?: 0) <= 500 && (options?.size ?: 0) <= 50 && (options?.all { it.value.isNotEmpty() && it.value.length <= 80 && it.label.length <= 120 } ?: true)
}
@Serializable data class AidenAppControlSnapshot(val version: Int, val title: String, val target: String, val policy: String, val rows: List<AidenAppControlRow>) {
    val isWireSafe get() = version == 1 && title.isNotEmpty() && title.length <= 120 && target.isNotEmpty() && target.length <= 256 && policy in setOf("disabled", "ask", "safe") && rows.size <= 8 && rows.all { it.isWireSafe } && rows.map { it.id }.distinct().size == rows.size
}
@Serializable data class AidenAppControlOperation(val control: String, val value: JsonPrimitive, val expectedRevision: String, val operationId: String) {
    val isWireSafe get() = control in controlIds && safeValue(value) && token(expectedRevision) && token(operationId)
}
@Serializable data class AidenAppControlReceipt(val status: String, val operationId: String, val control: String, val value: JsonPrimitive, val scope: String, val effective: String, val warning: String? = null) {
    val isWireSafe get() = status in setOf("applied", "already_set", "outcome_unknown") && token(operationId) && control in controlIds && safeValue(value) && scope.length <= 256 && effective in setOf("now", "next_turn", "next_session", "after_preview") && (warning?.length ?: 0) <= 500
}


/** Owned by a foreground chat model, with at most 16 visible card registrations. */
class AidenAppControlCache {
    private val state = kotlinx.coroutines.flow.MutableStateFlow<Map<String, AidenAppControlSnapshot>>(emptyMap())
    val snapshots: kotlinx.coroutines.flow.StateFlow<Map<String, AidenAppControlSnapshot>> = state
    private val tracked = linkedMapOf<String, AidenAppControlPanel>()
    private var generation = 0L
    suspend fun load(panel: AidenAppControlPanel, read: suspend (AidenAppControlPanel) -> AidenAppControlSnapshot): AidenAppControlSnapshot {
        check(tracked.containsKey(panel.id) || tracked.size < 16)
        tracked[panel.id] = panel
        val epoch = generation
        try {
            val value = read(panel)
            kotlinx.coroutines.currentCoroutineContext().ensureActive()
            if (epoch != generation || tracked[panel.id] != panel) throw kotlinx.coroutines.CancellationException("Card replaced")
            state.value = state.value + (panel.id to value)
            return value
        } catch (error: Exception) {
            if (epoch == generation) state.value = state.value - panel.id
            throw error
        }
    }
    fun remove(panel: AidenAppControlPanel) { tracked.remove(panel.id); state.value = state.value - panel.id }
    fun clearSnapshots() { generation++; state.value = emptyMap() }
    suspend fun refresh(read: suspend (AidenAppControlPanel) -> AidenAppControlSnapshot) {
        val epoch = ++generation
        for (panel in tracked.values.toList()) {
            if (epoch != generation) return
            try {
                val value = read(panel)
                kotlinx.coroutines.currentCoroutineContext().ensureActive()
                if (epoch != generation) return
                if (tracked[panel.id] == panel) state.value = state.value + (panel.id to value)
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                if (epoch != generation) return
                state.value = state.value - panel.id
            }
        }
    }
}
