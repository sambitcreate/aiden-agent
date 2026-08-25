package sbtbiswas.AidenOnTheGo

import androidx.compose.animation.AnimatedContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import sbtbiswas.AidenOnTheGo.features.remote.AidenConnectionState
import sbtbiswas.AidenOnTheGo.features.remote.AidenPairingScreen
import sbtbiswas.AidenOnTheGo.features.remote.AidenProductShellScreen
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.persistence.AidenProductNavigationStore
import sbtbiswas.AidenOnTheGo.config.AidenVoiceInputStore
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@Composable
fun ContentView(
    coordinator: AidenRemoteCoordinator,
    installationStore: AidenInstallationStore,
    navigationStore: AidenProductNavigationStore,
    chatCache: AidenChatCache,
    voiceInputStore: AidenVoiceInputStore,
    onNavigateToChat: (String) -> Unit,
    onNavigateToBotProfile: (String) -> Unit,
    onNavigateToBotEditor: (String?) -> Unit,
    onNavigateToWorkspaceFiles: (String) -> Unit,
    onNavigateToWorkspaceGit: (String) -> Unit
) {
    val connectionState by coordinator.connectionState.collectAsState()

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = AidenTheme.palette.canvas
    ) {
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
                        voiceInputStore = voiceInputStore,
                        onNavigateToChat = onNavigateToChat,
                        onNavigateToBotProfile = onNavigateToBotProfile,
                        onNavigateToBotEditor = onNavigateToBotEditor,
                        onNavigateToWorkspaceFiles = onNavigateToWorkspaceFiles,
                        onNavigateToWorkspaceGit = onNavigateToWorkspaceGit
                    )
                }
            }
        }
    }
}
