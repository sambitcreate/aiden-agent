package sbtbiswas.AidenOnTheGo

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotEditorScreen
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotMemoryScreen
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotProfileScreen
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotsViewModel
import sbtbiswas.AidenOnTheGo.features.bots.AidenRemoteBotDeleter
import sbtbiswas.AidenOnTheGo.features.chat.AidenBotChatRoute
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
import sbtbiswas.AidenOnTheGo.notifications.AidenNewChatLinkConsent
import sbtbiswas.AidenOnTheGo.notifications.AidenExternalNewChatQueue
import sbtbiswas.AidenOnTheGo.features.remote.pairing
import sbtbiswas.AidenOnTheGo.protocol.AidenRemoteCapability
import sbtbiswas.AidenOnTheGo.features.remote.AidenConnectionState
import kotlinx.coroutines.CancellationException
import sbtbiswas.AidenOnTheGo.navigation.AidenNavigationHost
import sbtbiswas.AidenOnTheGo.navigation.AidenNavigationStack
import sbtbiswas.AidenOnTheGo.navigation.rememberAidenNavigator
import sbtbiswas.AidenOnTheGo.navigation.AidenScreen
import sbtbiswas.AidenOnTheGo.persistence.AidenProductArea
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import kotlinx.coroutines.launch
import sbtbiswas.AidenOnTheGo.notifications.AidenScheduledRunNotifier

class MainActivity : ComponentActivity() {
    private val pendingNavigationRequest = mutableStateOf<AidenNavigationRequest?>(null)
    private var pendingDeepLink: String? = null
    private val newChatConsent = AidenNewChatLinkConsent()
    private val externalNewChats = AidenExternalNewChatQueue()
    private var lastExternalNewChat: AidenNavigationRequest? = null

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
            // Revision 27: finished Bot routine runs are posted when the app comes to the
            // foreground (there is no push), and once a Mac that offers them connects.
            val serverInfo by coordinator.serverInfo.collectAsStateWithLifecycle()
            val routineNotifier = remember { AidenScheduledRunNotifier(applicationContext) }
            val foregroundScope = rememberCoroutineScope()
            val pendingNewChat by newChatConsent.pending.collectAsStateWithLifecycle()
            val approvedNewChat by newChatConsent.approved.collectAsStateWithLifecycle()
            // An approval is never restored after Activity recreation or backgrounding.
            LifecycleEventEffect(Lifecycle.Event.ON_STOP) { newChatConsent.invalidate() }

            fun retained(target: AidenNewChatLinkConsent.Target): Boolean =
                installationStore.installations.value.any { it.pairing == target.pairing }

            LaunchedEffect(approvedNewChat, connectionState, activeInstallationId, installations,
                workspaces, hasCompletedWorkspaceRefresh) {
                val target = approvedNewChat ?: return@LaunchedEffect
                if (!retained(target) || coordinator.activePairing != target.pairing) {
                    newChatConsent.invalidate()
                    return@LaunchedEffect
                }
                if (connectionState == AidenConnectionState.OFFLINE || connectionState == AidenConnectionState.NEEDS_PAIRING) {
                    newChatConsent.invalidate()
                    return@LaunchedEffect
                }
                if (connectionState == AidenConnectionState.CONNECTING || !hasCompletedWorkspaceRefresh) return@LaunchedEffect
                val client = coordinator.pairedClient(target.pairing) ?: return@LaunchedEffect
                fun valid(): Boolean = retained(target) && coordinator.holdsReadAuthority(client, target.pairing.instanceId) &&
                    coordinator.activePairing == target.pairing && coordinator.connectionState.value == AidenConnectionState.CONNECTED &&
                    installationStore.activeInstallation?.hasNegotiatedAccess(AidenRemoteCapability.CHAT_WRITE) == true &&
                    coordinator.workspaces.value.any { it.id == target.workspaceId } &&
                    !coordinator.archiveStore.isArchived(target.workspaceId, target.pairing.instanceId)
                // This scope is independent of list refreshes. perform consumes approval before I/O.
                foregroundScope.launch {
                    try {
                        // A chat started under Chats can land in a fresh hidden workspace of its own.
                        val startsUnderChats = coordinator.workspaces.value.any { it.id == target.workspaceId && it.noWorkspace }
                        val chat = newChatConsent.perform(target, ::valid) {
                            requireNotNull(client).createChat(target.workspaceId)
                        } ?: return@launch
                        if (chat.isBotChat || (chat.workspaceId != target.workspaceId && !startsUnderChats)) return@launch
                        if (coordinator.workspaces.value.none { it.id == chat.workspaceId }) coordinator.refreshWorkspaces()
                        navigationStore.setSelectedArea(target.pairing.instanceId, AidenProductArea.WORKSPACES)
                        navigator.navigate(navigator.stack.resetTo(AidenScreen.ChatDetail(chat.id)))
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (error: Exception) {
                        if (valid()) coordinator.presentError(error.message ?: "Aiden couldn't create the chat. Check Workspaces before trying again.")
                    }
                }
            }
            LaunchedEffect(activeInstallationId, installations, connectionState) {
                val target = pendingNewChat ?: return@LaunchedEffect
                if (!retained(target) || coordinator.activePairing != target.origin || connectionState != AidenConnectionState.CONNECTED) {
                    newChatConsent.invalidate()
                }
            }
            LifecycleEventEffect(Lifecycle.Event.ON_START) {
                foregroundScope.launch { routineNotifier.deliverBotRoutines(coordinator) }
            }
            LaunchedEffect(connectionState, serverInfo) {
                if (connectionState == sbtbiswas.AidenOnTheGo.features.remote.AidenConnectionState.CONNECTED) {
                    routineNotifier.deliverBotRoutines(coordinator)
                }
            }

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
                if (request.destination == AidenNavigationDestination.NewChat) {
                    // Keep the latest navigation pending through connection/workspace refresh.
                    // The request still owns no switch, creation or microphone authority.
                    val entry = externalNewChats.takeIfReady(
                        connectionState == AidenConnectionState.CONNECTED && hasCompletedWorkspaceRefresh
                    ) { candidate ->
                        candidate.origin != null && candidate.origin == coordinator.activePairing &&
                            candidate.target != null && installations.any { it.pairing == candidate.target }
                    }
                    if (entry == null) {
                        if (externalNewChats.waiting == null || connectionState == AidenConnectionState.NEEDS_PAIRING) {
                            externalNewChats.invalidate()
                            coordinator.presentError("Connect to the paired Aiden installation before opening this link.")
                            clearPendingNavigation()
                        }
                        return@LaunchedEffect
                    }
                    val instanceId = entry.target?.instanceId
                    val installation = installations.firstOrNull { it.pairing == entry.target }
                    val catalog = container.intentCatalogStore.load()
                    val candidates = if (coordinator.activeInstanceId == instanceId) {
                        sbtbiswas.AidenOnTheGo.models.AidenNoWorkspace.grouped(workspaces)
                            .map { sbtbiswas.AidenOnTheGo.intents.AidenIntentWorkspaceRecord(it.id, instanceId.orEmpty(), it.name) }
                    } else catalog.workspaces.filter { it.instanceId == instanceId }
                    val available = candidates.filterNot { coordinator.archiveStore.isArchived(it.id, instanceId) }
                    val selected = request.workspaceId ?: instanceId?.let(navigationStore::selectedWorkspaceId)
                    val workspace = available.firstOrNull { it.id == selected }
                        ?: if (request.workspaceId == null) available.firstOrNull() else null
                    clearPendingNavigation()
                    if (installation == null || workspace == null) {
                        coordinator.presentError("Open this installation and choose an available workspace before starting a chat.")
                    } else {
                        newChatConsent.propose(AidenNewChatLinkConsent.Target(installation.pairing, installation.name,
                            workspace.id, workspace.name, coordinator.activePairing,
                            originClient = coordinator.pairedClient(coordinator.activePairing)))
                    }
                    return@LaunchedEffect
                }
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
                // A chat this device has saved opens at once, without waiting for the Mac;
                // the detail rereads it as the connection comes up.
                val requestedChat = request.destination as? AidenNavigationDestination.Chat
                val cachedInstance = coordinator.activeInstanceId
                if (requestedChat != null && cachedInstance != null) {
                    val cached = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                        chatCache.loadChat(cachedInstance, requestedChat.chatId)
                    }
                    if (cached != null && (cached.isBotChat || !coordinator.archiveStore.isArchived(cached.workspaceId, cachedInstance))) {
                        navigationStore.setSelectedArea(
                            cachedInstance,
                            if (cached.isBotChat) AidenProductArea.BOTS else AidenProductArea.WORKSPACES
                        )
                        navigator.navigate(navigator.stack.resetTo(AidenScreen.ChatDetail(cached.id, request.startsVoice)))
                        clearPendingNavigation()
                        return@LaunchedEffect
                    }
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
                            if (coordinator.supportsBotDurableSession()) {
                                navigationStore.setSelectedArea(
                                    coordinator.activeInstanceId.orEmpty(),
                                    AidenProductArea.BOTS
                                )
                                navigator.navigate(navigator.stack.resetTo(AidenScreen.BotChat(destination.botId)))
                            } else try {
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
                    AidenNavigationDestination.NewChat -> Unit // Always handled by consent above.

                }
                clearPendingNavigation()
            }

            AidenTheme(config = appearanceConfig) {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = AidenTheme.palette.canvas
                ) {
                    pendingNewChat?.let { target ->
                        AlertDialog(
                            onDismissRequest = { newChatConsent.invalidate() },
                            title = { Text("Create a new chat?") },
                            text = { Text("Create a chat in ${target.workspaceName} on ${target.installationName}? Use the microphone button when you are ready to dictate.") },
                            confirmButton = {
                                TextButton(onClick = {
                                    val approved = newChatConsent.approve(target.id, { candidate ->
                                        retained(candidate) && coordinator.activePairing == candidate.origin &&
                                            candidate.originClient != null && coordinator.pairedClient(candidate.origin) === candidate.originClient &&
                                            coordinator.connectionState.value == AidenConnectionState.CONNECTED
                                    }) ?: return@TextButton
                                    if (installationStore.activeInstallationId.value != approved.pairing.instanceId) {
                                        installationStore.setActiveInstallation(approved.pairing.instanceId)
                                        navigator.navigate(AidenNavigationStack.Root)
                                    }
                                }) { Text("Create Chat") }
                            },
                            dismissButton = { TextButton(onClick = { newChatConsent.invalidate() }) { Text("Cancel") } }
                        )
                    }
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
                                    onNavigateToChat = { chatId -> navigator.openFromShell(AidenScreen.ChatDetail(chatId)) },
                                    onNavigateToBotProfile = { botId -> push(AidenScreen.BotProfile(botId)) },
                                    onNavigateToBotChat = { botId -> push(AidenScreen.BotChat(botId)) },
                                    onNavigateToBotEditor = { botId -> push(AidenScreen.BotEditor(botId)) },
                                    onNavigateToWorkspaceFiles = { wsId -> push(AidenScreen.WorkspaceFiles(wsId)) },
                                    onNavigateToWorkspaceGit = { wsId -> push(AidenScreen.WorkspaceGit(wsId)) },
                                    onOpenSettings = { push(AidenScreen.Settings()) },
                                    onOpenInstallations = { push(AidenScreen.Installations) },
                                    onNavigateToBotMemory = { botId -> push(AidenScreen.BotMemory(botId)) }
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
                                    onNavigateToBotProfile = { botId -> push(AidenScreen.BotProfile(botId)) },
                                    botDeleter = AidenRemoteBotDeleter,
                                    onNavigateBack = navigator::back
                                )
                            }
                            is AidenScreen.BotChat -> {
                                AidenBotChatRoute(
                                    botId = screen.botId,
                                    coordinator = coordinator,
                                    chatCache = chatCache,
                                    draftStore = draftStore,
                                    voiceInputStore = voiceInputStore,
                                    liveNotificationManager = liveNotificationManager,
                                    networkAvailability = networkAvailability,
                                    onNavigateToChat = { chatId -> push(AidenScreen.ChatDetail(chatId)) },
                                    onNavigateToBotProfile = { botId -> push(AidenScreen.BotProfile(botId)) },
                                    onNavigateBack = {
                                        botsViewModel.loadBots(force = true)
                                        navigator.back()
                                    },
                                    // A deleted Bot's profile may sit below its chat: return to the list.
                                    onBotDeleted = {
                                        botsViewModel.loadBots(force = true)
                                        navigator.navigate(AidenNavigationStack.Root)
                                    },
                                    onNavigateToBotMemory = { botId -> push(AidenScreen.BotMemory(botId)) }
                                )
                            }
                            is AidenScreen.BotMemory -> {
                                AidenBotMemoryScreen(
                                    botId = screen.botId,
                                    coordinator = coordinator,
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
                                    onNavigateToMemory = { botId -> push(AidenScreen.BotMemory(botId)) },
                                    onBotMutated = { botsViewModel.loadBots(force = true) },
                                    botDeleter = AidenRemoteBotDeleter,
                                    onBotDeleted = {
                                        botsViewModel.loadBots(force = true)
                                        navigator.navigate(AidenNavigationStack.Root)
                                    }
                                )
                            }
                            is AidenScreen.BotEditor -> {
                                AidenBotEditorScreen(
                                    botId = screen.botId,
                                    coordinator = coordinator,
                                    onNavigateBack = navigator::back,
                                    onBotSaved = { botId ->
                                        botsViewModel.loadBots(force = true)
                                        // Creating a Bot opens its chat; saving instructions returns to the profile.
                                        navigator.navigate(
                                            if (screen.botId == null) navigator.stack.completeBotCreate(botId)
                                            else navigator.stack.completeBotEdit(botId)
                                        )
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
        if (request?.destination == AidenNavigationDestination.NewChat) {
            if (request == lastExternalNewChat && (externalNewChats.waiting != null || newChatConsent.hasPendingOrActive)) return
            newChatConsent.invalidate()
            lastExternalNewChat = request
        } else if (request != null) {
            newChatConsent.invalidate()
            lastExternalNewChat = null
        }
        val container = (application as AidenOnTheGoApp).container
        val targetInstance = request?.instanceId ?: container.coordinator.activeInstanceId
        externalNewChats.receive(request, container.coordinator.activePairing,
            container.installationStore.installations.value.firstOrNull { it.id == targetInstance }?.pairing)
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
