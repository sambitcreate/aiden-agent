package sbtbiswas.AidenOnTheGo

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import sbtbiswas.AidenOnTheGo.auth.AndroidAidenSecureStore
import sbtbiswas.AidenOnTheGo.config.AidenAppearanceStore
import sbtbiswas.AidenOnTheGo.config.AidenVoiceInputStore
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.intents.AidenIntentCatalogStore
import sbtbiswas.AidenOnTheGo.notifications.AidenRemoteLiveNotificationManager
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.persistence.AidenChatDraftStore
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.persistence.AidenProductNavigationStore

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
    val coordinator = AidenRemoteCoordinator(
        installationStore = installationStore,
        storageDir = filesDir,
        chatCache = chatCache,
        draftStore = draftStore,
        navigationStore = navigationStore,
        intentCatalogStore = intentCatalogStore,
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    )
}
