package sbtbiswas.AidenOnTheGo.features.settings

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.config.AidenAppearanceStore
import sbtbiswas.AidenOnTheGo.config.AidenVoiceInputStore
import sbtbiswas.AidenOnTheGo.features.bots.AidenBotsViewModel
import sbtbiswas.AidenOnTheGo.features.remote.AidenProductShellScreen
import sbtbiswas.AidenOnTheGo.features.remote.AidenRemoteCoordinator
import sbtbiswas.AidenOnTheGo.navigation.AidenNavigationHost
import sbtbiswas.AidenOnTheGo.navigation.AidenScreen
import sbtbiswas.AidenOnTheGo.navigation.rememberAidenNavigator
import sbtbiswas.AidenOnTheGo.persistence.AidenChatCache
import sbtbiswas.AidenOnTheGo.persistence.AidenInstallationStore
import sbtbiswas.AidenOnTheGo.persistence.AidenProductNavigationStore
import sbtbiswas.AidenOnTheGo.persistence.AidenSettingsCache
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import java.io.File
import java.util.UUID

/** Settings is a pushed full-screen destination of the product shell, not a sheet over it. */
@RunWith(AndroidJUnit4::class)
class AidenSettingsNavigationUiTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var root: File

    @After
    fun tearDown() {
        scope.cancel()
        root.deleteRecursively()
    }

    @Test
    fun settingsOpensFullScreenFromTheShellScrollsToItsLastGroupAndReturns() {
        val activity = compose.activity
        root = File(activity.cacheDir, "settings-nav-${UUID.randomUUID()}")
        val installationStore = AidenInstallationStore(root, InMemorySecureStore())
        val chatCache = AidenChatCache(root)
        val navigationStore = AidenProductNavigationStore(root)
        val coordinator = AidenRemoteCoordinator(
            installationStore = installationStore,
            storageDir = root,
            chatCache = chatCache,
            navigationStore = navigationStore,
            scope = scope
        )
        val settingsStore = AidenSettingsStore(AidenSettingsCache(File(root, "settings")), scope)
        val appearanceStore = AidenAppearanceStore(root)
        val voiceInputStore = AidenVoiceInputStore(activity)

        compose.setContent {
            val navigator = rememberAidenNavigator()
            val botsViewModel: AidenBotsViewModel = viewModel(factory = AidenBotsViewModel.factory(coordinator))
            AidenTheme {
                AidenNavigationHost(navigator = navigator, reduceMotion = true) { screen ->
                    when (screen) {
                        AidenScreen.ProductShell -> AidenProductShellScreen(
                            coordinator = coordinator,
                            navigationStore = navigationStore,
                            installationStore = installationStore,
                            chatCache = chatCache,
                            botsViewModel = botsViewModel,
                            onNavigateToChat = {},
                            onNavigateToBotProfile = {},
                            onNavigateToBotEditor = {},
                            onNavigateToWorkspaceFiles = {},
                            onNavigateToWorkspaceGit = {},
                            onOpenSettings = { navigator.push(AidenScreen.Settings()) },
                            onOpenInstallations = { navigator.push(AidenScreen.Installations) }
                        )
                        is AidenScreen.Settings -> AidenSettingsDestination(
                            page = screen.page,
                            settingsStore = settingsStore,
                            appearanceStore = appearanceStore,
                            voiceInputStore = voiceInputStore,
                            installationStore = installationStore,
                            onNavigate = { navigator.push(AidenScreen.Settings(it)) },
                            onOpenInstallations = {},
                            onNavigateBack = navigator::back
                        )
                        else -> Unit
                    }
                }
            }
        }

        compose.onNodeWithContentDescription("Settings").performClick()

        compose.onNodeWithTag(AidenSettingsListTag).assertIsDisplayed()
        compose.onNodeWithContentDescription("New Bot").assertDoesNotExist()
        val about = hasText("About") and hasClickAction()
        compose.onNodeWithTag(AidenSettingsListTag).performScrollToNode(about)
        compose.onNode(about).assertIsDisplayed()

        compose.onNodeWithContentDescription("Back").performClick()

        compose.onNodeWithTag(AidenSettingsListTag).assertDoesNotExist()
        compose.onNodeWithContentDescription("New Bot").assertIsDisplayed()
    }
}
