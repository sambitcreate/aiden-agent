package sbtbiswas.AidenOnTheGo

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotEditorScreen
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotProfileScreen
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotsViewModel
import sbtbiswas.AidenOnTheGo.features.chat.AidenChatDetailScreen
import sbtbiswas.AidenOnTheGo.features.remote.AidenInstallationsScreen
import sbtbiswas.AidenOnTheGo.features.remote.AidenPairDesktopScreen
import sbtbiswas.AidenOnTheGo.features.settings.AidenSettingsDestination
import sbtbiswas.AidenOnTheGo.features.workspaces.AidenGitScreen
import sbtbiswas.AidenOnTheGo.features.workspaces.AidenWorkspaceEnvironmentScreen
import sbtbiswas.AidenOnTheGo.models.AidenBotDeepLinkResolution
import sbtbiswas.AidenOnTheGo.models.aidenResolvedBotDeepLink
import sbtbiswas.AidenOnTheGo.notifications.AidenDeepLink
import sbtbiswas.AidenOnTheGo.notifications.AidenNavigationDestination
import sbtbiswas.AidenOnTheGo.notifications.AidenNavigationRequest
import sbtbiswas.AidenOnTheGo.navigation.AidenNavigationHost
import sbtbiswas.AidenOnTheGo.navigation.AidenNavigationStack
import sbtbiswas.AidenOnTheGo.navigation.rememberAidenNavigator
import sbtbiswas.AidenOnTheGo.navigation.AidenScreen
import sbtbiswas.AidenOnTheGo.persistence.AidenProductArea
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import androidx.lifecycle.compose.collectAsStateWithLifecycle

class MainActivity : ComponentActivity() {
    private val pendingNavigationRequest = mutableStateOf<AidenNavigationRequest?>(null)
    private var pendingDeepLink: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val container = (application as AidenOnTheGoApp).container
        val installationStore = container.installationStore
        val chatCache = container.chatCache
        val draftStore = container.draftStore
        val navigationStore = container.navigationStore
        val appearanceStore = container.appearanceStore
        val voiceInputStore = container.voiceInputStore
        val settingsStore = container.settingsStore
        val liveNotificationManager = container.liveNotificationManager
        val networkAvailability = container.networkAvailability
        val coordinator = container.coordinator
        // A recreated Activity keeps its intent; re-reading it would replay the
        // link (and create another chat for a new-chat link). Only an unhandled
        // request survives recreation.
        acceptDeepLink(
            if (savedInstanceState == null) intent?.dataString
            else savedInstanceState.getString(PENDING_DEEP_LINK_KEY)
        )

        setContent {
            val appearanceConfig by appearanceStore.config.collectAsStateWithLifecycle()
            val connectionState by coordinator.connectionState.collectAsStateWithLifecycle()
            val workspaces by coordinator.workspaces.collectAsStateWithLifecycle()
            val hasCompletedWorkspaceRefresh by coordinator.hasCompletedWorkspaceRefresh.collectAsStateWithLifecycle()
            val activeInstallationId by installationStore.activeInstallationId.collectAsStateWithLifecycle()
            val installations by installationStore.installations.collectAsStateWithLifecycle()
            val navigator = rememberAidenNavigator()
            fun push(screen: AidenScreen) = navigator.push(screen)
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
                    clearPendingNavigation()
                    return@LaunchedEffect
                }
                if (requestedInstance != null && activeInstallationId != requestedInstance) {
                    installationStore.setActiveInstallation(requestedInstance)
                    navigator.navigate(AidenNavigationStack.Root)
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
                                    clearPendingNavigation()
                                    return@LaunchedEffect
                                }
                                navigationStore.setSelectedArea(
                                    coordinator.activeInstanceId.orEmpty(),
                                    if (chat.isBotChat) AidenProductArea.BOTS else AidenProductArea.WORKSPACES
                                )
                                navigator.navigate(navigator.stack.resetTo(AidenScreen.ChatDetail(chat.id, request.startsVoice)))
                            } catch (error: Exception) {
                                coordinator.presentError(error.message ?: "That chat is unavailable.")
                            }
                        }
                    }
                    is AidenNavigationDestination.BotChat -> {
                        val client = coordinator.client.value
                        if (client == null) {
                            coordinator.presentError("Connect to Aiden Agent before opening this link.")
                        } else {
                            try {
                                val page = client.botConversations(botId = destination.botId)
                                when (val resolved = aidenResolvedBotDeepLink(destination.botId, page.conversations)) {
                                    is AidenBotDeepLinkResolution.OpenChat -> {
                                        val chat = client.chat(resolved.chatId)
                                        if (chat.botId != destination.botId) {
                                            coordinator.presentError("That Bot chat is no longer available.")
                                        } else {
                                            navigationStore.setSelectedArea(
                                                coordinator.activeInstanceId.orEmpty(),
                                                AidenProductArea.BOTS
                                            )
                                            navigator.navigate(navigator.stack.resetTo(AidenScreen.ChatDetail(chat.id)))
                                        }
                                    }
                                    AidenBotDeepLinkResolution.ShowBot -> {
                                        // A link never creates a conversation; the profile offers that.
                                        val bot = client.bot(destination.botId)
                                        navigationStore.setSelectedArea(
                                            coordinator.activeInstanceId.orEmpty(),
                                            AidenProductArea.BOTS
                                        )
                                        navigator.navigate(navigator.stack.resetTo(AidenScreen.BotProfile(bot.id)))
                                    }
                                }
                            } catch (error: Exception) {
                                coordinator.presentError(error.message ?: "That Bot is unavailable.")
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
                                navigator.navigate(navigator.stack.resetTo(AidenScreen.ChatDetail(chat.id, request.startsVoice)))
                            } catch (error: Exception) {
                                coordinator.presentError(error.message ?: "Aiden couldn't create the chat.")
                            }
                        }
                    }
                }
                clearPendingNavigation()
            }

            AidenTheme(config = appearanceConfig) {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = AidenTheme.palette.canvas
                ) {
                    AidenNavigationHost(
                        navigator = navigator,
                        reduceMotion = sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion()
                    ) { screen ->
                        when (screen) {
                            is AidenScreen.ProductShell -> {
                                ContentView(
                                    coordinator = coordinator,
                                    navigationStore = navigationStore,
                                    installationStore = installationStore,
                                    chatCache = chatCache,
                                    botsViewModel = botsViewModel,
                                    onNavigateToChat = { chatId -> push(AidenScreen.ChatDetail(chatId)) },
                                    onNavigateToBotProfile = { botId -> push(AidenScreen.BotProfile(botId)) },
                                    onNavigateToBotEditor = { botId -> push(AidenScreen.BotEditor(botId)) },
                                    onNavigateToWorkspaceFiles = { wsId -> push(AidenScreen.WorkspaceFiles(wsId)) },
                                    onNavigateToWorkspaceGit = { wsId -> push(AidenScreen.WorkspaceGit(wsId)) },
                                    onOpenSettings = { push(AidenScreen.Settings()) },
                                    onOpenInstallations = { push(AidenScreen.Installations) }
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
                                    networkAvailability = networkAvailability,
                                    startVoiceOnOpen = screen.startsVoice,
                                    onNavigateToChat = { chatId -> push(AidenScreen.ChatDetail(chatId)) },
                                    onNavigateBack = navigator::back
                                )
                            }
                            is AidenScreen.BotProfile -> {
                                AidenBotProfileScreen(
                                    botId = screen.botId,
                                    coordinator = coordinator,
                                    onNavigateBack = navigator::back,
                                    onNavigateToChat = { chatId -> push(AidenScreen.ChatDetail(chatId)) },
                                    onNavigateToEditBot = { botId -> push(AidenScreen.BotEditor(botId)) },
                                    onBotMutated = { botsViewModel.loadBots(force = true) }
                                )
                            }
                            is AidenScreen.BotEditor -> {
                                AidenBotEditorScreen(
                                    botId = screen.botId,
                                    coordinator = coordinator,
                                    onNavigateBack = navigator::back,
                                    onBotSaved = { botId ->
                                        botsViewModel.loadBots(force = true)
                                        navigator.navigate(navigator.stack.completeBotEdit(botId))
                                    }
                                )
                            }
                            is AidenScreen.WorkspaceFiles -> {
                                AidenWorkspaceEnvironmentScreen(
                                    workspaceId = screen.workspaceId,
                                    coordinator = coordinator,
                                    onNavigateBack = navigator::back
                                )
                            }
                            is AidenScreen.WorkspaceGit -> {
                                AidenGitScreen(
                                    workspaceId = screen.workspaceId,
                                    coordinator = coordinator,
                                    onNavigateBack = navigator::back
                                )
                            }
                            is AidenScreen.Settings -> {
                                AidenSettingsDestination(
                                    page = screen.page,
                                    settingsStore = settingsStore,
                                    appearanceStore = appearanceStore,
                                    voiceInputStore = voiceInputStore,
                                    installationStore = installationStore,
                                    onNavigate = { page -> push(AidenScreen.Settings(page)) },
                                    onOpenInstallations = { push(AidenScreen.Installations) },
                                    onNavigateBack = navigator::back
                                )
                            }
                            AidenScreen.Installations -> {
                                AidenInstallationsScreen(
                                    coordinator = coordinator,
                                    installationStore = installationStore,
                                    onPairDesktop = { push(AidenScreen.PairDesktop) },
                                    onNavigateBack = navigator::back
                                )
                            }
                            AidenScreen.PairDesktop -> {
                                AidenPairDesktopScreen(
                                    coordinator = coordinator,
                                    firstRun = false,
                                    onPaired = navigator::back,
                                    onNavigateBack = navigator::back
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
        acceptDeepLink(intent.dataString)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (pendingNavigationRequest.value != null) outState.putString(PENDING_DEEP_LINK_KEY, pendingDeepLink)
    }

    private fun acceptDeepLink(data: String?) {
        if (data == null) return
        val request = AidenDeepLink.parse(data)
        pendingDeepLink = data.takeIf { request != null }
        pendingNavigationRequest.value = request
    }

    private fun clearPendingNavigation() {
        pendingNavigationRequest.value = null
        pendingDeepLink = null
    }

    private companion object {
        const val PENDING_DEEP_LINK_KEY = "aiden.pendingDeepLink"
    }
}
