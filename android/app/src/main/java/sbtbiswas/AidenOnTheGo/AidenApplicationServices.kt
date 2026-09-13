package sbtbiswas.AidenOnTheGo

import android.content.Context
import sbtbiswas.AidenOnTheGo.auth.AndroidAidenSecureStore
import sbtbiswas.AidenOnTheGo.config.*
import sbtbiswas.AidenOnTheGo.persistence.*
import sbtbiswas.AidenOnTheGo.intents.AidenIntentCatalogStore
import sbtbiswas.AidenOnTheGo.notifications.AidenRemoteLiveNotificationManager
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator

/** Application-owned services survive Activity recreation without duplicating connections. */
class AidenApplicationServices(context: Context) {
    val filesDir = context.applicationContext.filesDir
    val secureStore = AndroidAidenSecureStore(context.applicationContext)
    val installationStore = AidenInstallationStore(filesDir, secureStore)
    val chatCache = AidenChatCache(filesDir)
    val draftStore = AidenChatDraftStore(filesDir)
    val navigationStore = AidenProductNavigationStore(filesDir)
    val appearanceStore = AidenAppearanceStore(filesDir)
    val voiceInputStore = AidenVoiceInputStore(context.applicationContext)
    val intentCatalogStore = AidenIntentCatalogStore(context.applicationContext)
    val liveNotificationManager = AidenRemoteLiveNotificationManager(context.applicationContext)
    val coordinator = AidenRemoteCoordinator(
        installationStore = installationStore,
        storageDir = filesDir,
        chatCache = chatCache,
        draftStore = draftStore,
        navigationStore = navigationStore,
        intentCatalogStore = intentCatalogStore
    )
}
