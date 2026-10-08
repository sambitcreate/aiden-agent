package sbtbiswas.AidenOnTheGo

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.auth.AndroidAidenSecureStore
import sbtbiswas.AidenOnTheGo.config.AidenAppearanceStore
import sbtbiswas.AidenOnTheGo.config.AidenVoiceInputStore
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.features.settings.AidenRemoteClientSettings
import sbtbiswas.AidenOnTheGo.features.settings.AidenSettingsStore
import sbtbiswas.AidenOnTheGo.intents.AidenIntentCatalogStore
import sbtbiswas.AidenOnTheGo.networking.AidenConnectivityNetworkAvailability
import sbtbiswas.AidenOnTheGo.notifications.AidenRemoteLiveNotificationManager
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.persistence.AidenChatDraftStore
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.persistence.AidenProductNavigationStore
import sbtbiswas.AidenOnTheGo.persistence.AidenSettingsCache
import java.io.File

/**
 * Process-lifetime graph of stores and the Remote coordinator. Activities are
 * recreated on rotation, theme, and locale changes; building these per
 * Activity leaked a coordinator (with its never-cancelled scope, collectors,
 * and pinned OkHttp client) on every recreation.
 */
class AidenAppContainer(context: Context) {
    private val appContext = context.applicationContext
    private val filesDir = appContext.filesDir

    val installationStore = AidenInstallationStore(filesDir, AndroidAidenSecureStore(appContext))
    val chatCache = AidenChatCache(filesDir)
    val draftStore = AidenChatDraftStore(filesDir)
    val navigationStore = AidenProductNavigationStore(filesDir)
    val appearanceStore = AidenAppearanceStore(filesDir)
    val voiceInputStore = AidenVoiceInputStore(appContext)
    val intentCatalogStore = AidenIntentCatalogStore(appContext)
    val liveNotificationManager = AidenRemoteLiveNotificationManager(appContext)
    val networkAvailability = AidenConnectivityNetworkAvailability(appContext)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    val coordinator = AidenRemoteCoordinator(
        installationStore = installationStore,
        storageDir = filesDir,
        chatCache = chatCache,
        draftStore = draftStore,
        navigationStore = navigationStore,
        intentCatalogStore = intentCatalogStore,
        scope = scope
    )
    private val settingsCache = AidenSettingsCache(File(filesDir, "settings_cache"))
    val settingsStore = AidenSettingsStore(settingsCache, scope)

    init {
        // Settings follows the active client; its cache is dropped with the pairing.
        scope.launch {
            coordinator.client.collect { client ->
                settingsStore.bind(installationStore.activeInstallation?.instanceId, client?.let(::AidenRemoteClientSettings))
            }
        }
        scope.launch(Dispatchers.IO) {
            installationStore.installations.collect { installations ->
                settingsCache.retainOnly(installations.mapTo(HashSet()) { it.instanceId })
            }
        }
    }
}
