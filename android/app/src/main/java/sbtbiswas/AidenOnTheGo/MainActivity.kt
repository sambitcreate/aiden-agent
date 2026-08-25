package sbtbiswas.AidenOnTheGo

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.*
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import sbtbiswas.AidenOnTheGo.auth.AndroidAidenSecureStore
import sbtbiswas.AidenOnTheGo.config.AidenAppearanceStore
import sbtbiswas.AidenOnTheGo.config.AidenVoiceInputStore
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotEditorScreen
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotProfileScreen
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotsViewModel
import sbtbiswas.AidenOnTheGo.features.chat.AidenChatDetailScreen
import sbtbiswas.AidenOnTheGo.features.remote.AidenProductShellScreen
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.features.workspaces.AidenGitScreen
import sbtbiswas.AidenOnTheGo.features.workspaces.AidenWorkspaceEnvironmentScreen
import sbtbiswas.AidenOnTheGo.intents.AidenIntentCatalogStore
import sbtbiswas.AidenOnTheGo.notifications.AidenDeepLink
import sbtbiswas.AidenOnTheGo.notifications.AidenNavigationDestination
import sbtbiswas.AidenOnTheGo.notifications.AidenNavigationRequest
import sbtbiswas.AidenOnTheGo.notifications.AidenRemoteLiveNotificationManager
import sbtbiswas.AidenOnTheGo.persistence.*
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

sealed class AidenScreen {
    object ProductShell : AidenScreen()
    data class ChatDetail(val chatId: String, val startsVoice: Boolean = false) : AidenScreen()
    data class BotProfile(val botId: String) : AidenScreen()
    data class BotEditor(val botId: String?) : AidenScreen()
    data class WorkspaceFiles(val workspaceId: String) : AidenScreen()
    data class WorkspaceGit(val workspaceId: String) : AidenScreen()
}

class MainActivity : ComponentActivity() {
    private val pendingNavigationRequest = mutableStateOf<AidenNavigationRequest?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val filesDir = applicationContext.filesDir
        val secureStore = AndroidAidenSecureStore(applicationContext)
        val installationStore = AidenInstallationStore(filesDir, secureStore)
        val chatCache = AidenChatCache(filesDir)
        val draftStore = AidenChatDraftStore(filesDir)
        val navigationStore = AidenProductNavigationStore(filesDir)
        val appearanceStore = AidenAppearanceStore(filesDir)
        val voiceInputStore = AidenVoiceInputStore(applicationContext)
        val intentCatalogStore = AidenIntentCatalogStore(applicationContext)
        val liveNotificationManager = AidenRemoteLiveNotificationManager(applicationContext)
        val coordinator = AidenRemoteCoordinator(
            installationStore = installationStore,
            storageDir = filesDir,
            chatCache = chatCache,
            draftStore = draftStore,
            navigationStore = navigationStore,
            intentCatalogStore = intentCatalogStore
        )
        acceptDeepLink(intent)

        setContent {
            val appearanceConfig by appearanceStore.config.collectAsState()
            val connectionState by coordinator.connectionState.collectAsState()
            val workspaces by coordinator.workspaces.collectAsState()
            val hasCompletedWorkspaceRefresh by coordinator.hasCompletedWorkspaceRefresh.collectAsState()
            val activeInstallationId by installationStore.activeInstallationId.collectAsState()
            val installations by installationStore.installations.collectAsState()
            var currentScreen by remember { mutableStateOf<AidenScreen>(AidenScreen.ProductShell) }
            val botsViewModel: AidenBotsViewModel = viewModel(
                factory = AidenBotsViewModel.factory(coordinator)
            )

            LaunchedEffect(
                pendingNavigationRequest.value,
                connectionState,
                activeInstallationId,
                installations,
                workspaces,
                hasCompletedWorkspaceRefresh
            ) {
                val request = pendingNavigationRequest.value ?: return@LaunchedEffect
                val requestedInstance = request.instanceId
                if (requestedInstance != null && installations.none { it.id == requestedInstance }) {
                    coordinator.presentError("This Aiden installation is no longer paired. Pair it again to continue.")
                    pendingNavigationRequest.value = null
                    return@LaunchedEffect
                }
                if (requestedInstance != null && activeInstallationId != requestedInstance) {
                    installationStore.setActiveInstallation(requestedInstance)
                    currentScreen = AidenScreen.ProductShell
                    return@LaunchedEffect
                }
                if (connectionState != sbtbiswas.AidenOnTheGo.features.remote.AidenConnectionState.CONNECTED) {
                    return@LaunchedEffect
                }

                when (val destination = request.destination) {
                    is AidenNavigationDestination.Chat -> {
                        val client = coordinator.client.value
                        if (client == null) {
                            coordinator.presentError("Connect to Aiden Agent before opening this link.")
                        } else {
                            try {
                                val chat = client.chat(destination.chatId)
                                if (
                                    !chat.isBotChat &&
                                    coordinator.archiveStore.isArchived(chat.workspaceId, coordinator.activeInstanceId)
                                ) {
                                    coordinator.presentError("That chat belongs to a workspace archived on this device.")
                                    pendingNavigationRequest.value = null
                                    return@LaunchedEffect
                                }
                                navigationStore.setSelectedArea(
                                    coordinator.activeInstanceId.orEmpty(),
                                    if (chat.isBotChat) AidenProductArea.BOTS else AidenProductArea.WORKSPACES
                                )
                                currentScreen = AidenScreen.ChatDetail(chat.id, request.startsVoice)
                            } catch (error: Exception) {
                                coordinator.presentError(error.message ?: "That chat is unavailable.")
                            }
                        }
                    }
                    AidenNavigationDestination.NewChat -> {
                        if (!hasCompletedWorkspaceRefresh) return@LaunchedEffect
                        val activeWorkspaces = workspaces.filterNot { workspace ->
                            coordinator.archiveStore.isArchived(workspace.id, coordinator.activeInstanceId)
                        }
                        val workspace = if (request.workspaceId != null) {
                            activeWorkspaces.firstOrNull { it.id == request.workspaceId }
                        } else {
                            activeWorkspaces.firstOrNull()
                        }
                        val client = coordinator.client.value
                        if (workspace == null || client == null) {
                            coordinator.presentError("Choose or add a workspace before starting a chat.")
                        } else {
                            try {
                                val chat = client.createChat(workspace.id)
                                navigationStore.setSelectedArea(
                                    coordinator.activeInstanceId.orEmpty(),
                                    AidenProductArea.WORKSPACES
                                )
                                currentScreen = AidenScreen.ChatDetail(chat.id, request.startsVoice)
                            } catch (error: Exception) {
                                coordinator.presentError(error.message ?: "Aiden couldn't create the chat.")
                            }
                        }
                    }
                }
                pendingNavigationRequest.value = null
            }

            AidenTheme(config = appearanceConfig) {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = AidenTheme.palette.canvas
                ) {
                    AnimatedContent(
                        targetState = currentScreen,
                        label = "ScreenTransition",
                        transitionSpec = {
                            if (targetState is AidenScreen.ProductShell) {
                                (slideInVertically(
                                    initialOffsetY = { -it / 10 },
                                    animationSpec = sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion.spatialExpressiveSpring<androidx.compose.ui.unit.IntOffset>()
                                ) + fadeIn(sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion.nonSpatialExpressiveSpring<Float>())).togetherWith(
                                    slideOutVertically(
                                        targetOffsetY = { it / 10 },
                                        animationSpec = sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion.spatialExpressiveSpring<androidx.compose.ui.unit.IntOffset>()
                                    ) + fadeOut(sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion.nonSpatialExpressiveSpring<Float>())
                                )
                            } else {
                                (slideInVertically(
                                    initialOffsetY = { it / 8 },
                                    animationSpec = sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion.spatialExpressiveSpring<androidx.compose.ui.unit.IntOffset>()
                                ) + fadeIn(sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion.nonSpatialExpressiveSpring<Float>())).togetherWith(
                                    slideOutVertically(
                                        targetOffsetY = { -it / 8 },
                                        animationSpec = sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion.spatialExpressiveSpring<androidx.compose.ui.unit.IntOffset>()
                                    ) + fadeOut(sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion.nonSpatialExpressiveSpring<Float>())
                                )
                            }
                        }
                    ) { screen ->
                        when (screen) {
                            is AidenScreen.ProductShell -> {
                                ContentView(
                                    coordinator = coordinator,
                                    navigationStore = navigationStore,
                                    installationStore = installationStore,
                                    chatCache = chatCache,
                                    appearanceStore = appearanceStore,
                                    voiceInputStore = voiceInputStore,
                                    botsViewModel = botsViewModel,
                                    onNavigateToChat = { chatId -> currentScreen = AidenScreen.ChatDetail(chatId) },
                                    onNavigateToBotProfile = { botId -> currentScreen = AidenScreen.BotProfile(botId) },
                                    onNavigateToBotEditor = { botId -> currentScreen = AidenScreen.BotEditor(botId) },
                                    onNavigateToWorkspaceFiles = { wsId -> currentScreen = AidenScreen.WorkspaceFiles(wsId) },
                                    onNavigateToWorkspaceGit = { wsId -> currentScreen = AidenScreen.WorkspaceGit(wsId) }
                                )
                            }
                            is AidenScreen.ChatDetail -> {
                                AidenChatDetailScreen(
                                    chatId = screen.chatId,
                                    coordinator = coordinator,
                                    chatCache = chatCache,
                                    draftStore = draftStore,
                                    voiceInputStore = voiceInputStore,
                                    liveNotificationManager = liveNotificationManager,
                                    startVoiceOnOpen = screen.startsVoice,
                                    onNavigateBack = { currentScreen = AidenScreen.ProductShell }
                                )
                            }
                            is AidenScreen.BotProfile -> {
                                AidenBotProfileScreen(
                                    botId = screen.botId,
                                    coordinator = coordinator,
                                    onNavigateBack = { currentScreen = AidenScreen.ProductShell },
                                    onNavigateToChat = { chatId -> currentScreen = AidenScreen.ChatDetail(chatId) },
                                    onNavigateToEditBot = { botId -> currentScreen = AidenScreen.BotEditor(botId) },
                                    onBotMutated = { botsViewModel.loadBots(force = true) }
                                )
                            }
                            is AidenScreen.BotEditor -> {
                                AidenBotEditorScreen(
                                    botId = screen.botId,
                                    coordinator = coordinator,
                                    onNavigateBack = { currentScreen = AidenScreen.ProductShell },
                                    onBotSaved = { botId ->
                                        botsViewModel.loadBots(force = true)
                                        currentScreen = AidenScreen.BotProfile(botId)
                                    }
                                )
                            }
                            is AidenScreen.WorkspaceFiles -> {
                                AidenWorkspaceEnvironmentScreen(
                                    workspaceId = screen.workspaceId,
                                    coordinator = coordinator,
                                    onNavigateBack = { currentScreen = AidenScreen.ProductShell }
                                )
                            }
                            is AidenScreen.WorkspaceGit -> {
                                AidenGitScreen(
                                    workspaceId = screen.workspaceId,
                                    coordinator = coordinator,
                                    onNavigateBack = { currentScreen = AidenScreen.ProductShell }
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        acceptDeepLink(intent)
    }

    private fun acceptDeepLink(intent: Intent?) {
        val data = intent?.dataString ?: return
        pendingNavigationRequest.value = AidenDeepLink.parse(data)
    }
}
