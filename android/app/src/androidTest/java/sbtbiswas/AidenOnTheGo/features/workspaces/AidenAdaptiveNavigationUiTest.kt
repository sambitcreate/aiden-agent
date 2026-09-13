package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.ExperimentalMaterial3AdaptiveApi
import androidx.compose.material3.adaptive.navigation3.SupportingPaneSceneStrategy
import androidx.compose.material3.adaptive.navigation3.rememberSupportingPaneSceneStrategy
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.navigation3.runtime.*
import androidx.navigation3.ui.NavDisplay
import org.junit.Rule
import org.junit.Test
import org.junit.Assert.assertEquals
import sbtbiswas.AidenOnTheGo.AidenScreen
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

/** Regression probe for stable adaptive scene synchronization during width changes. */
@OptIn(ExperimentalMaterial3AdaptiveApi::class, ExperimentalTestApi::class)
class AidenAdaptiveNavigationUiTest {
    @get:Rule val compose = createComposeRule()

    @Test fun explicitSplitTogglePreservesChatDraftAndEnvironmentEntry() {
        var split by mutableStateOf(false)
        compose.setContent {
            DeviceConfigurationOverride(DeviceConfigurationOverride.ForcedSize(DpSize(1000.dp, 900.dp))) {
                AidenTheme {
                    val stack = rememberNavBackStack(AidenScreen.ChatDetail("chat"), AidenScreen.Environment("workspace", "chat"))
                    val wide = androidx.compose.material3.adaptive.layout.calculatePaneScaffoldDirective(androidx.compose.material3.adaptive.currentWindowAdaptiveInfoV2())
                    val strategy = rememberSupportingPaneSceneStrategy<NavKey>(directive = if (split) wide else wide.copy(maxHorizontalPartitions = 1))
                    NavDisplay(backStack = stack, onBack = {}, sceneStrategies = listOf(strategy), entryDecorators = listOf(rememberSaveableStateHolderNavEntryDecorator()), entryProvider = { key ->
                        val main = key is AidenScreen.ChatDetail
                        NavEntry(key, metadata = if (main) SupportingPaneSceneStrategy.mainPane("chat") else SupportingPaneSceneStrategy.supportingPane("chat")) {
                            if (main) {
                                var draft by rememberSaveable { mutableStateOf("") }
                                BasicTextField(draft, { draft = it }, Modifier.testTag("split-draft"))
                            } else Text("Native Browser", Modifier.testTag("split-browser"))
                        }
                    })
                }
            }
        }
        compose.onNodeWithTag("split-browser").assertIsDisplayed()
        compose.onNodeWithTag("split-draft").assertDoesNotExist()
        compose.runOnIdle { split = true }
        compose.onNodeWithTag("split-draft").performTextInput("Retain this composer")
        compose.runOnIdle { split = false }
        compose.onNodeWithTag("split-browser").assertIsDisplayed()
        compose.runOnIdle { split = true }
        compose.onNodeWithTag("split-draft").assertTextEquals("Retain this composer")
    }

    @Test fun supportingPaneResizePreservesChatDraftAndBackStack() {
        var width by mutableIntStateOf(1000)
        var stack: NavBackStack<NavKey>? = null
        val restoration = StateRestorationTester(compose)
        restoration.setContent {
            DeviceConfigurationOverride(DeviceConfigurationOverride.ForcedSize(DpSize(width.dp, 900.dp))) {
                AidenTheme {
                    val backStack = rememberNavBackStack(AidenScreen.ChatDetail("chat"))
                    SideEffect { stack = backStack }
                    val strategy = rememberSupportingPaneSceneStrategy<NavKey>()
                    NavDisplay(
                        backStack = backStack,
                        modifier = Modifier.fillMaxSize(),
                        onBack = { backStack.removeLastOrNull() },
                        sceneStrategies = listOf(strategy),
                        entryDecorators = listOf(rememberSaveableStateHolderNavEntryDecorator()),
                        entryProvider = { key ->
                            val main = key is AidenScreen.ChatDetail
                            NavEntry(key, metadata = if (main) SupportingPaneSceneStrategy.mainPane("chat") else SupportingPaneSceneStrategy.supportingPane("chat")) {
                                if (main) {
                                    var draft by rememberSaveable { mutableStateOf("") }
                                    BasicTextField(draft, { draft = it }, Modifier.testTag("draft"))
                                } else Text("Environment content", Modifier.testTag("environment"))
                            }
                        }
                    )
                }
            }
        }
        compose.onNodeWithTag("draft").performTextInput("Keep my draft")
        compose.runOnIdle { stack!!.add(AidenScreen.Environment("workspace", "chat")) }
        compose.onNodeWithTag("draft").assertIsDisplayed()
        compose.onNodeWithTag("environment").assertIsDisplayed()
        repeat(3) {
            compose.runOnIdle { width = 400 }
            compose.onNodeWithTag("environment").assertIsDisplayed()
            compose.runOnIdle { width = 1000 }
            compose.onNodeWithTag("draft").assertTextEquals("Keep my draft")
            compose.onNodeWithTag("environment").assertIsDisplayed()
            compose.runOnIdle { assertEquals(2, stack!!.size) }
        }
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithTag("draft").assertTextEquals("Keep my draft")
        compose.onNodeWithTag("environment").assertIsDisplayed()
        compose.runOnIdle { assertEquals(2, stack!!.size) }
        compose.runOnIdle { stack!!.removeLastOrNull() }
        compose.onNodeWithTag("draft").assertTextEquals("Keep my draft")
    }
}
