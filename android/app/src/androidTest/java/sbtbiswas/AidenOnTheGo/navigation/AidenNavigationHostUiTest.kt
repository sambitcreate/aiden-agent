package sbtbiswas.AidenOnTheGo.navigation

import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenNavigationHostUiTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private lateinit var navigator: AidenNavigator

    @Composable
    private fun Host() {
        navigator = rememberAidenNavigator()
        AidenTheme {
            AidenNavigationHost(navigator = navigator, reduceMotion = true) { screen ->
                when (screen) {
                    AidenScreen.ProductShell -> Column {
                        var taps by rememberSaveable { mutableIntStateOf(0) }
                        Text("shell taps $taps")
                        Button(onClick = { taps += 1 }) { Text("tap") }
                        Button(onClick = { navigator.push(AidenScreen.BotProfile("b1")) }) { Text("open bot") }
                    }
                    is AidenScreen.BotProfile -> Column {
                        var showingDetail by remember { mutableStateOf(false) }
                        BackHandler(enabled = showingDetail) { showingDetail = false }
                        Text(if (showingDetail) "bot detail" else "bot ${screen.botId}")
                        Button(onClick = { showingDetail = true }) { Text("show detail") }
                        Button(onClick = { navigator.push(AidenScreen.ChatDetail("c1")) }) { Text("open chat") }
                    }
                    is AidenScreen.ChatDetail -> Text("chat ${screen.chatId}")
                    else -> Text("other")
                }
            }
        }
    }

    /**
     * System back as the platform delivers it: through the activity's back dispatcher,
     * where both the host's predictive handler and in-screen handlers are registered.
     * Espresso's key injection also waits for window focus, which CI emulators can
     * withhold from the test activity, so it would test the emulator rather than the host.
     */
    private fun pressSystemBack() {
        compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.waitForIdle()
    }

    @Test
    fun systemBackPopsOneScreenAtATimeAndRestoresTheEarlierScreenState() {
        compose.setContent { Host() }

        compose.onNodeWithText("tap").performClick()
        compose.onNodeWithText("tap").performClick()
        compose.onNodeWithText("open bot").performClick()
        compose.onNodeWithText("open chat").performClick()
        compose.onNodeWithText("chat c1").assertIsDisplayed()

        pressSystemBack()
        compose.onNodeWithText("bot b1").assertIsDisplayed()

        pressSystemBack()
        compose.onNodeWithText("shell taps 2").assertIsDisplayed()
        compose.runOnIdle { assertFalse(navigator.stack.canPop) }
    }

    @Test
    fun anInScreenBackTargetIsConsumedBeforeTheScreenPops() {
        compose.setContent { Host() }
        compose.onNodeWithText("open bot").performClick()
        compose.onNodeWithText("show detail").performClick()
        compose.onNodeWithText("bot detail").assertIsDisplayed()

        pressSystemBack()
        compose.onNodeWithText("bot b1").assertIsDisplayed()

        pressSystemBack()
        compose.onNodeWithText("shell taps 0").assertIsDisplayed()
    }

    @Test
    fun theBackStackSurvivesActivityRecreation() {
        val restoration = StateRestorationTester(compose)
        restoration.setContent { Host() }
        compose.onNodeWithText("open bot").performClick()
        compose.onNodeWithText("open chat").performClick()

        restoration.emulateSavedInstanceStateRestore()

        compose.onNodeWithText("chat c1").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals(
                listOf(AidenScreen.ProductShell, AidenScreen.BotProfile("b1"), AidenScreen.ChatDetail("c1")),
                navigator.stack.entries
            )
        }
        pressSystemBack()
        compose.onNodeWithText("bot b1").assertIsDisplayed()
    }
}
