package sbtbiswas.AidenOnTheGo

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.*
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import sbtbiswas.AidenOnTheGo.auth.AndroidAidenSecureStore
import sbtbiswas.AidenOnTheGo.config.AidenAppearanceStore
import sbtbiswas.AidenOnTheGo.config.AidenVoiceInputStore
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotEditorScreen
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotProfileScreen
import sbtbiswas.AidenOnTheGo.features.chat.AidenChatDetailScreen
import sbtbiswas.AidenOnTheGo.features.remote.AidenProductShellScreen
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.features.workspaces.AidenGitScreen
import sbtbiswas.AidenOnTheGo.features.workspaces.AidenWorkspaceEnvironmentScreen
import sbtbiswas.AidenOnTheGo.persistence.*
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

sealed class AidenScreen {
    object ProductShell : AidenScreen()
    data class ChatDetail(val chatId: String) : AidenScreen()
    data class BotProfile(val botId: String) : AidenScreen()
    data class BotEditor(val botId: String?) : AidenScreen()
    data class WorkspaceFiles(val workspaceId: String) : AidenScreen()
    data class WorkspaceGit(val workspaceId: String) : AidenScreen()
}

class MainActivity : ComponentActivity() {
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
        val coordinator = AidenRemoteCoordinator(installationStore, filesDir)

        setContent {
            val appearanceConfig by appearanceStore.config.collectAsState()
            var currentScreen by remember { mutableStateOf<AidenScreen>(AidenScreen.ProductShell) }

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
                                AidenProductShellScreen(
                                    coordinator = coordinator,
                                    navigationStore = navigationStore,
                                    installationStore = installationStore,
                                    chatCache = chatCache,
                                    appearanceStore = appearanceStore,
                                    voiceInputStore = voiceInputStore,
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
                                    onNavigateBack = { currentScreen = AidenScreen.ProductShell }
                                )
                            }
                            is AidenScreen.BotProfile -> {
                                AidenBotProfileScreen(
                                    botId = screen.botId,
                                    coordinator = coordinator,
                                    onNavigateBack = { currentScreen = AidenScreen.ProductShell },
                                    onNavigateToChat = { chatId -> currentScreen = AidenScreen.ChatDetail(chatId) },
                                    onNavigateToEditBot = { botId -> currentScreen = AidenScreen.BotEditor(botId) }
                                )
                            }
                            is AidenScreen.BotEditor -> {
                                AidenBotEditorScreen(
                                    botId = screen.botId,
                                    coordinator = coordinator,
                                    onNavigateBack = { currentScreen = AidenScreen.ProductShell },
                                    onBotSaved = { botId -> currentScreen = AidenScreen.BotProfile(botId) }
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
}
