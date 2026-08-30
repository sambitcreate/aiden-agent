package sbtbiswas.AidenOnTheGo.intents

import android.content.Context
import android.content.SharedPreferences
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import sbtbiswas.AidenOnTheGo.notifications.AidenDeepLink

@Serializable
data class AidenIntentInstallationRecord(
    val id: String,
    val name: String
)

@Serializable
data class AidenIntentWorkspaceRecord(
    val id: String,
    val instanceId: String,
    val name: String
)

@Serializable
data class AidenIntentCatalogSnapshot(
    val installations: List<AidenIntentInstallationRecord> = emptyList(),
    val workspaces: List<AidenIntentWorkspaceRecord> = emptyList(),
    val activeInstallationId: String? = null
)

class AidenIntentCatalogStore(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("aiden_intent_catalog_prefs", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    fun load(): AidenIntentCatalogSnapshot {
        val raw = prefs.getString(KEY_CATALOG, null) ?: return AidenIntentCatalogSnapshot()
        return try {
            val decoded = json.decodeFromString<AidenIntentCatalogSnapshot>(raw)
            val installations = decoded.installations
                .filter { safeId(it.id) && safeName(it.name) }
                .distinctBy { it.id }
            val installationIds = installations.map { it.id }.toSet()
            val workspaces = decoded.workspaces
                .filter { safeId(it.id) && safeId(it.instanceId) && safeName(it.name) && it.instanceId in installationIds }
                .distinctBy { "${it.instanceId}\u001f${it.id}" }
            AidenIntentCatalogSnapshot(
                installations = installations,
                workspaces = workspaces,
                activeInstallationId = decoded.activeInstallationId?.takeIf { it in installationIds }
            )
        } catch (_: Exception) {
            AidenIntentCatalogSnapshot()
        }
    }

    fun update(
        installations: List<AidenIntentInstallationRecord>,
        activeInstallationId: String?,
        workspaces: List<AidenIntentWorkspaceRecord>,
        forInstanceId: String? = activeInstallationId
    ) {
        val sanitizedInstallations = installations
            .filter { safeId(it.id) && safeName(it.name) }
            .distinctBy { it.id }
        val installationIds = sanitizedInstallations.map { it.id }.toSet()
        val retainedWorkspaces = load().workspaces.filter {
            it.instanceId != forInstanceId && it.instanceId in installationIds
        }
        val sanitizedWorkspaces = workspaces.filter {
            safeId(it.id) && safeId(it.instanceId) && safeName(it.name) && it.instanceId in installationIds
        }
        val snapshot = AidenIntentCatalogSnapshot(
            installations = sanitizedInstallations,
            workspaces = (retainedWorkspaces + sanitizedWorkspaces)
                .distinctBy { "${it.instanceId}\u001f${it.id}" },
            activeInstallationId = activeInstallationId?.takeIf { it in installationIds }
        )
        val serialized = json.encodeToString(snapshot)
        prefs.edit().putString(KEY_CATALOG, serialized).apply()
    }

    companion object {
        private const val KEY_CATALOG = "aiden.intent_catalog.v1"

        private fun safeId(value: String): Boolean =
            value.isNotEmpty() && value.length <= 160 && value.all {
                it.isLetterOrDigit() || it == '.' || it == '_' || it == ':' || it == '-'
            }

        private fun safeName(value: String): Boolean =
            value.isNotBlank() && value.length <= 256 && value.none { Character.isISOControl(it) }
    }
}
