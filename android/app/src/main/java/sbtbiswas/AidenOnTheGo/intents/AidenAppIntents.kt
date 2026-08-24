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
            json.decodeFromString<AidenIntentCatalogSnapshot>(raw)
        } catch (_: Exception) {
            AidenIntentCatalogSnapshot()
        }
    }

    fun update(
        installations: List<AidenIntentInstallationRecord>,
        activeInstallationId: String?,
        workspaces: List<AidenIntentWorkspaceRecord>
    ) {
        val snapshot = AidenIntentCatalogSnapshot(
            installations = installations.distinctBy { it.id },
            workspaces = workspaces.distinctBy { "${it.instanceId}_${it.id}" },
            activeInstallationId = activeInstallationId
        )
        val serialized = json.encodeToString(snapshot)
        prefs.edit().putString(KEY_CATALOG, serialized).apply()
    }

    companion object {
        private const val KEY_CATALOG = "aiden.intent_catalog.v1"
    }
}
