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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.navigation3.runtime.*
import androidx.navigation3.ui.NavDisplay
import androidx.lifecycle.viewmodel.navigation3.rememberViewModelStoreNavEntryDecorator
import androidx.compose.material3.adaptive.ExperimentalMaterial3AdaptiveApi
import androidx.compose.material3.adaptive.navigation3.*
import kotlinx.serialization.Serializable
import sbtbiswas.AidenOnTheGo.features.workspaces.AidenChatEnvironmentPane
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

@Serializable
sealed class AidenScreen : NavKey {
    @Serializable object ProductShell : AidenScreen()
    @Serializable data class ChatDetail(val chatId: String, val startsVoice: Boolean = false) : AidenScreen()
    @Serializable data class BotProfile(val botId: String) : AidenScreen()
    @Serializable data class BotEditor(val botId: String?) : AidenScreen()
    @Serializable data class WorkspaceFiles(val workspaceId: String) : AidenScreen()
    @Serializable data class Environment(val workspaceId: String, val chatId: String) : AidenScreen()
    @Serializable data class WorkspaceGit(val workspaceId: String) : AidenScreen()
}

@OptIn(ExperimentalMaterial3AdaptiveApi::class)
class MainActivity : ComponentActivity() {
    private val pendingNavigationRequest = mutableStateOf<AidenNavigationRequest?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val services = (application as AidenOnTheGoApp).services
        val installationStore = services.installationStore
        val chatCache = services.chatCache
        val draftStore = services.draftStore
        val navigationStore = services.navigationStore
        val appearanceStore = services.appearanceStore
        val voiceInputStore = services.voiceInputStore
        val liveNotificationManager = services.liveNotificationManager
        val coordinator = services.coordinator
        if (savedInstanceState == null) acceptDeepLink(intent)

        setContent {
            val appearanceConfig by appearanceStore.config.collectAsState()
            val connectionState by coordinator.connectionState.collectAsState()
            val workspaces by coordinator.workspaces.collectAsState()
            val hasCompletedWorkspaceRefresh by coordinator.hasCompletedWorkspaceRefresh.collectAsState()
            val activeInstallationId by installationStore.activeInstallationId.collectAsState()
            val installations by installationStore.installations.collectAsState()
            val backStack = rememberNavBackStack(AidenScreen.ProductShell)
            fun navigate(screen: AidenScreen) {
                if (screen == AidenScreen.ProductShell) {
                    backStack.clear()
                    backStack.add(screen)
                } else {
                    val existing = backStack.indexOfLast { entry ->
                        entry == screen || (entry is AidenScreen.ChatDetail && screen is AidenScreen.ChatDetail && entry.chatId == screen.chatId)
                    }
                    if (existing >= 0) {
                        while (backStack.lastIndex > existing) backStack.removeLastOrNull()
                    } else backStack.add(screen)
                }
            }
            fun navigateBack() { if (backStack.size > 1) backStack.removeLastOrNull() }
            var navigationInstallation by rememberSaveable { mutableStateOf(activeInstallationId) }
            LaunchedEffect(activeInstallationId) {
                if (navigationInstallation != activeInstallationId) {
                    navigate(AidenScreen.ProductShell)
                    navigationInstallation = activeInstallationId
                }
            }
            var splitEnvironment by rememberSaveable { mutableStateOf(false) }
            val wideDirective = androidx.compose.material3.adaptive.layout.calculatePaneScaffoldDirective(androidx.compose.material3.adaptive.currentWindowAdaptiveInfoV2())
            val canSplitEnvironment = wideDirective.maxHorizontalPartitions > 1
            val paneStrategy = rememberSupportingPaneSceneStrategy<NavKey>(directive = if (splitEnvironment) wideDirective else wideDirective.copy(maxHorizontalPartitions = 1))
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
                    navigate(AidenScreen.ProductShell)
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
                                navigate(AidenScreen.ChatDetail(chat.id, request.startsVoice))
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
                                navigate(AidenScreen.ChatDetail(chat.id, request.startsVoice))
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
                    if (navigationInstallation == activeInstallationId) NavDisplay(
                        backStack = backStack,
                        onBack = ::navigateBack,
                        sceneStrategies = listOf(paneStrategy),
                        entryDecorators = listOf(
                            rememberSaveableStateHolderNavEntryDecorator(),
                            rememberViewModelStoreNavEntryDecorator()
                        ),
                        entryProvider = { key ->
                            val screen = key as AidenScreen
                            val metadata = when (screen) {
                                is AidenScreen.ChatDetail -> SupportingPaneSceneStrategy.mainPane(screen.chatId)
                                is AidenScreen.Environment -> SupportingPaneSceneStrategy.supportingPane(screen.chatId)
                                else -> emptyMap()
                            }
                            NavEntry(key, metadata = metadata) {
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
                                    onNavigateToChat = { chatId -> navigate(AidenScreen.ChatDetail(chatId)) },
                                    onNavigateToBotProfile = { botId -> navigate(AidenScreen.BotProfile(botId)) },
                                    onNavigateToBotEditor = { botId -> navigate(AidenScreen.BotEditor(botId)) },
                                    onNavigateToWorkspaceFiles = { wsId -> navigate(AidenScreen.WorkspaceFiles(wsId)) },
                                    onNavigateToWorkspaceGit = { wsId -> navigate(AidenScreen.WorkspaceGit(wsId)) }
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
                                    onOpenEnvironment = { workspaceId -> splitEnvironment = false; navigate(AidenScreen.Environment(workspaceId, screen.chatId)) },
                                    onNavigateBack = ::navigateBack
                                )
                            }
                            is AidenScreen.BotProfile -> {
                                AidenBotProfileScreen(
                                    botId = screen.botId,
                                    coordinator = coordinator,
                                    onNavigateBack = ::navigateBack,
                                    onNavigateToChat = { chatId -> navigate(AidenScreen.ChatDetail(chatId)) },
                                    onNavigateToEditBot = { botId -> navigate(AidenScreen.BotEditor(botId)) },
                                    onBotMutated = { botsViewModel.loadBots(force = true) }
                                )
                            }
                            is AidenScreen.BotEditor -> {
                                AidenBotEditorScreen(
                                    botId = screen.botId,
                                    coordinator = coordinator,
                                    onNavigateBack = ::navigateBack,
                                    onBotSaved = { botId ->
                                        botsViewModel.loadBots(force = true)
                                        navigate(AidenScreen.BotProfile(botId))
                                    }
                                )
                            }
                            is AidenScreen.Environment -> {
                                AidenChatEnvironmentPane(screen.workspaceId, screen.chatId, coordinator, ::navigateBack, if (canSplitEnvironment) ({ splitEnvironment = !splitEnvironment }) else null, splitEnvironment)
                            }
                            is AidenScreen.WorkspaceFiles -> {
                                AidenWorkspaceEnvironmentScreen(
                                    workspaceId = screen.workspaceId,
                                    coordinator = coordinator,
                                    onNavigateBack = ::navigateBack
                                )
                            }
                            is AidenScreen.WorkspaceGit -> {
                                AidenGitScreen(
                                    workspaceId = screen.workspaceId,
                                    coordinator = coordinator,
                                    onNavigateBack = ::navigateBack
                                )
                            }
                        }
                            }
                        }
                    )
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
