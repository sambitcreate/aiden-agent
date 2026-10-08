package sbtbiswas.AidenOnTheGo

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.Box
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import sbtbiswas.AidenOnTheGo.features.remote.AidenConnectionState
import sbtbiswas.AidenOnTheGo.features.remote.AidenPairDesktopScreen
import sbtbiswas.AidenOnTheGo.features.remote.AidenProductShellScreen
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.persistence.AidenProductNavigationStore
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotsViewModel
import sbtbiswas.AidenOnTheGo.ui.theme.AidenMotion
import sbtbiswas.AidenOnTheGo.ui.theme.AidenSnackbar
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.aidenReduceMotion
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
fun ContentView(
    coordinator: AidenRemoteCoordinator,
    installationStore: AidenInstallationStore,
    navigationStore: AidenProductNavigationStore,
    chatCache: AidenChatCache,
    botsViewModel: AidenBotsViewModel,
    onNavigateToChat: (String) -> Unit,
    onNavigateToBotProfile: (String) -> Unit,
    onNavigateToBotEditor: (String?) -> Unit,
    onNavigateToWorkspaceFiles: (String) -> Unit,
    onNavigateToWorkspaceGit: (String) -> Unit,
    onOpenSettings: () -> Unit,
    onOpenInstallations: () -> Unit
) {
    val connectionState by coordinator.connectionState.collectAsStateWithLifecycle()
    val errorMessage by coordinator.errorMessage.collectAsStateWithLifecycle()
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
            val reduceMotion = aidenReduceMotion()
            AnimatedContent(
                targetState = connectionState,
                contentKey = { it == AidenConnectionState.NEEDS_PAIRING },
                transitionSpec = {
                    fadeIn(AidenMotion.nonSpatial(reduceMotion)) togetherWith
                        fadeOut(AidenMotion.nonSpatial(reduceMotion))
                },
                label = "ContentViewTransition"
            ) { state ->
                when (state) {
                AidenConnectionState.NEEDS_PAIRING -> {
                    // First run: nowhere to go back to, so the pair flow has no close action.
                    AidenPairDesktopScreen(
                        coordinator = coordinator,
                        firstRun = true,
                        onPaired = { coordinator.refreshClient() },
                        onNavigateBack = null,
                        installationStore = installationStore
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
                        botsViewModel = botsViewModel,
                        onNavigateToChat = onNavigateToChat,
                        onNavigateToBotProfile = onNavigateToBotProfile,
                        onNavigateToBotEditor = onNavigateToBotEditor,
                        onNavigateToWorkspaceFiles = onNavigateToWorkspaceFiles,
                        onNavigateToWorkspaceGit = onNavigateToWorkspaceGit,
                        onOpenSettings = onOpenSettings,
                        onOpenInstallations = onOpenInstallations
                    )
                }
                }
            }
            SnackbarHost(
                hostState = snackbarHostState,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .navigationBarsPadding()
                    .padding(bottom = 12.dp),
                snackbar = { data -> AidenSnackbar(data) }
            )
        }
    }
}
