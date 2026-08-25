package sbtbiswas.AidenOnTheGo

import androidx.compose.animation.AnimatedContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.Box
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import sbtbiswas.AidenOnTheGo.features.remote.AidenConnectionState
import sbtbiswas.AidenOnTheGo.features.remote.AidenPairingScreen
import sbtbiswas.AidenOnTheGo.features.remote.AidenProductShellScreen
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.persistence.AidenProductNavigationStore
import sbtbiswas.AidenOnTheGo.config.AidenVoiceInputStore
import sbtbiswas.AidenOnTheGo.config.AidenAppearanceStore
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotsViewModel
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@Composable
fun ContentView(
    coordinator: AidenRemoteCoordinator,
    installationStore: AidenInstallationStore,
    navigationStore: AidenProductNavigationStore,
    chatCache: AidenChatCache,
    appearanceStore: AidenAppearanceStore,
    voiceInputStore: AidenVoiceInputStore,
    botsViewModel: AidenBotsViewModel,
    onNavigateToChat: (String) -> Unit,
    onNavigateToBotProfile: (String) -> Unit,
    onNavigateToBotEditor: (String?) -> Unit,
    onNavigateToWorkspaceFiles: (String) -> Unit,
    onNavigateToWorkspaceGit: (String) -> Unit
) {
    val connectionState by coordinator.connectionState.collectAsState()
    val errorMessage by coordinator.errorMessage.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(errorMessage) {
        val message = errorMessage ?: return@LaunchedEffect
        snackbarHostState.showSnackbar(message)
        coordinator.clearError()
    }

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = AidenTheme.palette.canvas
    ) {
        Box(Modifier.fillMaxSize()) {
            AnimatedContent(
                targetState = connectionState,
                label = "ContentViewTransition"
            ) { state ->
                when (state) {
                AidenConnectionState.NEEDS_PAIRING -> {
                    AidenPairingScreen(
                        coordinator = coordinator,
                        installationStore = installationStore,
                        onDismiss = { coordinator.refreshClient() }
                    )
                }
                AidenConnectionState.CONNECTING,
                AidenConnectionState.CONNECTED,
                AidenConnectionState.OFFLINE -> {
                    AidenProductShellScreen(
                        coordinator = coordinator,
                        navigationStore = navigationStore,
                        installationStore = installationStore,
                        chatCache = chatCache,
                        appearanceStore = appearanceStore,
                        voiceInputStore = voiceInputStore,
                        botsViewModel = botsViewModel,
                        onNavigateToChat = onNavigateToChat,
                        onNavigateToBotProfile = onNavigateToBotProfile,
                        onNavigateToBotEditor = onNavigateToBotEditor,
                        onNavigateToWorkspaceFiles = onNavigateToWorkspaceFiles,
                        onNavigateToWorkspaceGit = onNavigateToWorkspaceGit
                    )
                }
                }
            }
            SnackbarHost(
                hostState = snackbarHostState,
                modifier = Modifier.align(Alignment.BottomCenter)
            )
        }
    }
}
