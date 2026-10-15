package sbtbiswas.AidenOnTheGo.navigation

import androidx.activity.BackEventCompat
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.Assert.assertTrue
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme
import sbtbiswas.AidenOnTheGo.ui.theme.AidenWindowWidthClass
import sbtbiswas.AidenOnTheGo.ui.theme.LocalAidenWindowClass

@RunWith(AndroidJUnit4::class)
class AidenNavigationHostUiTest {
    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private lateinit var navigator: AidenNavigator

    /** A phone-sized window, whatever device runs the test. */
    @Composable
    private fun Host(reduceMotion: Boolean = true) {
        navigator = rememberAidenNavigator()
        AidenTheme {
            CompositionLocalProvider(LocalAidenWindowClass provides AidenWindowWidthClass.Compact) {
                AidenNavigationHost(navigator = navigator, reduceMotion = reduceMotion) { Screen(it) }
            }
        }
    }

    /** A tablet-sized window laid out beyond the test device's own screen. */
    @Composable
    private fun WideHost() {
        navigator = rememberAidenNavigator()
        AidenTheme {
            CompositionLocalProvider(LocalAidenWindowClass provides AidenWindowWidthClass.Expanded) {
                Box(Modifier.wrapContentSize(align = Alignment.TopStart, unbounded = true)) {
                    Box(Modifier.requiredSize(1200.dp, 800.dp)) {
                        AidenNavigationHost(navigator = navigator, reduceMotion = false) { Screen(it) }
                    }
                }
            }
        }
    }

    @Composable
    private fun Screen(screen: AidenScreen) {
        when (screen) {
            AidenScreen.ProductShell -> Column {
                var taps by rememberSaveable { mutableIntStateOf(0) }
                Text("shell taps $taps")
                Button(onClick = { taps += 1 }) { Text("tap") }
                Button(onClick = { navigator.push(AidenScreen.BotProfile("b1")) }) { Text("open bot") }
                Button(onClick = { navigator.openFromShell(AidenScreen.ChatDetail("c1")) }) { Text("list c1") }
                Button(onClick = { navigator.openFromShell(AidenScreen.ChatDetail("c2")) }) { Text("list c2") }
            }
            is AidenScreen.BotProfile -> Column {
                var showingDetail by remember { mutableStateOf(false) }
                BackHandler(enabled = showingDetail) { showingDetail = false }
                Text(if (showingDetail) "bot detail" else "bot ${screen.botId}")
                Button(onClick = { showingDetail = true }) { Text("show detail") }
                Button(onClick = { navigator.push(AidenScreen.ChatDetail("c1")) }) { Text("open chat") }
            }
            is AidenScreen.ChatDetail -> Column {
                if (LocalAidenShowsUpNavigation.current) Text("up")
                Text("chat ${screen.chatId}")
                Text(if (LocalAidenIsCommittedDestination.current) "committed ${screen.chatId}" else "previewing ${screen.chatId}")
            }
            else -> Text("other")
        }
    }

    private val placeholder: String
        get() = compose.activity.getString(R.string.navigation_detail_placeholder_title)

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

    /** A predictive back gesture from the left edge, held at [progress] without releasing. */
    private fun dragBack(progress: Float) {
        // A click only changes the stack; the host enables its back handler when it
        // recomposes. A finger cannot start a gesture inside that same frame, so let it land.
        compose.waitForIdle()
        compose.runOnUiThread {
            val dispatcher = compose.activity.onBackPressedDispatcher
            dispatcher.dispatchOnBackStarted(BackEventCompat(0f, 400f, 0f, BackEventCompat.EDGE_LEFT))
            dispatcher.dispatchOnBackProgressed(BackEventCompat(120f, 400f, progress, BackEventCompat.EDGE_LEFT))
        }
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

    @Test
    fun aPredictiveBackGestureRevealsThePreviousScreenAndCancellingKeepsTheCurrentOne() {
        compose.setContent { Host(reduceMotion = false) }
        compose.onNodeWithText("open bot").performClick()
        compose.onNodeWithText("open chat").performClick()
        compose.onNodeWithText("bot b1").assertDoesNotExist()

        dragBack(progress = 0.6f)

        // Mid-gesture, the screen underneath is already composed while the chat is still current.
        compose.onNodeWithText("bot b1").assertExists()
        compose.onNodeWithText("chat c1").assertIsDisplayed()
        compose.runOnIdle { assertEquals(AidenScreen.ChatDetail("c1"), navigator.stack.current) }

        compose.runOnUiThread { compose.activity.onBackPressedDispatcher.dispatchOnBackCancelled() }
        compose.waitForIdle()

        compose.onNodeWithText("chat c1").assertIsDisplayed()
        compose.onNodeWithText("bot b1").assertDoesNotExist()
        compose.runOnIdle { assertEquals(3, navigator.stack.depth) }
    }

    @Test
    fun aChatRevealedByABackGestureIsNotCommittedUntilThePopLands() {
        compose.setContent { Host(reduceMotion = false) }
        compose.runOnUiThread {
            navigator.push(AidenScreen.ChatDetail("c1"))
            navigator.push(AidenScreen.ChatDetail("c2"))
        }
        compose.onNodeWithText("committed c2").assertIsDisplayed()

        dragBack(progress = 0.6f)
        // The chat underneath is composed for the preview but must not count as opened
        // (no read report, no notification dismissal) while the gesture can still cancel.
        compose.onNodeWithText("previewing c1").assertExists()
        compose.onNodeWithText("committed c1").assertDoesNotExist()
        compose.onNodeWithText("committed c2").assertExists()

        compose.runOnUiThread { compose.activity.onBackPressedDispatcher.dispatchOnBackCancelled() }
        compose.waitForIdle()
        compose.onNodeWithText("committed c2").assertIsDisplayed()
        compose.onNodeWithText("committed c1").assertDoesNotExist()

        dragBack(progress = 0.6f)
        pressSystemBack()
        compose.onNodeWithText("committed c1").assertIsDisplayed()
    }

    @Test
    fun releasingAPredictiveBackGesturePopsToTheRevealedScreenWithItsState() {
        compose.setContent { Host(reduceMotion = false) }
        compose.onNodeWithText("tap").performClick()
        compose.onNodeWithText("open bot").performClick()

        dragBack(progress = 0.8f)
        compose.onNodeWithText("shell taps 1").assertExists()

        pressSystemBack()

        compose.onNodeWithText("shell taps 1").assertIsDisplayed()
        compose.onNodeWithText("bot b1").assertDoesNotExist()
        compose.runOnIdle { assertFalse(navigator.stack.canPop) }
    }

    @Test
    fun reducedMotionSkipsThePreviewAndPopsOnRelease() {
        compose.setContent { Host(reduceMotion = true) }
        compose.onNodeWithText("open bot").performClick()

        dragBack(progress = 0.6f)
        compose.onNodeWithText("shell taps 0").assertDoesNotExist()

        pressSystemBack()
        compose.onNodeWithText("shell taps 0").assertIsDisplayed()
    }

    @Test
    fun aPhoneWindowShowsOneScreenAndKeepsTheChatsUpArrow() {
        compose.setContent { Host() }
        compose.onNodeWithText("list c1").performClick()

        compose.onNodeWithText("chat c1").assertIsDisplayed()
        compose.onNodeWithText("up").assertIsDisplayed()
        compose.onNodeWithText("shell taps 0").assertDoesNotExist()
    }

    @Test
    fun aWideWindowShowsTheShellBesideTheChatItOpened() {
        compose.setContent { WideHost() }
        compose.onNodeWithText(placeholder).assertExists()
        compose.onNodeWithText("tap").performClick()
        compose.onNodeWithText("list c1").performClick()

        compose.onNodeWithText("chat c1").assertExists()
        compose.onNodeWithText("shell taps 1").assertExists()
        compose.onNodeWithText(placeholder).assertDoesNotExist()
        // The shell beside it already leads back, so the chat drops its own arrow.
        compose.onNodeWithText("up").assertDoesNotExist()
        val shell = compose.onNodeWithText("shell taps 1").getUnclippedBoundsInRoot()
        val chat = compose.onNodeWithText("chat c1").getUnclippedBoundsInRoot()
        assertTrue("the chat sits beside the list pane", chat.left >= shell.left + AidenListPaneWidth)

        // Choosing another chat in the list replaces the open one instead of stacking.
        compose.onNodeWithText("list c2").performClick()
        compose.onNodeWithText("chat c2").assertExists()
        compose.onNodeWithText("chat c1").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(listOf(AidenScreen.ProductShell, AidenScreen.ChatDetail("c2")), navigator.stack.entries)
        }

        pressSystemBack()
        compose.onNodeWithText(placeholder).assertExists()
        compose.onNodeWithText("chat c2").assertDoesNotExist()
        compose.onNodeWithText("shell taps 1").assertExists()
        compose.runOnIdle { assertFalse(navigator.stack.canPop) }
    }

    @Test
    fun aWideWindowScrubsPredictiveBackInsideTheDetailPane() {
        compose.setContent { WideHost() }
        compose.onNodeWithText("tap").performClick()
        compose.onNodeWithText("list c1").performClick()

        dragBack(progress = 0.6f)
        compose.onNodeWithText(placeholder).assertExists()
        compose.onNodeWithText("chat c1").assertExists()
        compose.onNodeWithText("shell taps 1").assertExists()

        compose.runOnUiThread { compose.activity.onBackPressedDispatcher.dispatchOnBackCancelled() }
        compose.waitForIdle()
        compose.onNodeWithText("chat c1").assertExists()
        compose.onNodeWithText(placeholder).assertDoesNotExist()

        dragBack(progress = 0.8f)
        pressSystemBack()
        compose.onNodeWithText(placeholder).assertExists()
        compose.onNodeWithText("chat c1").assertDoesNotExist()
        compose.onNodeWithText("shell taps 1").assertExists()
    }

    @Test
    fun aScreenOpenedOverTheListDetailLayoutCoversItAndReturnsToIt() {
        compose.setContent { WideHost() }
        compose.onNodeWithText("tap").performClick()
        compose.onNodeWithText("list c1").performClick()
        compose.onNodeWithText("open bot").performClick()

        compose.onNodeWithText("bot b1").assertExists()
        compose.onNodeWithText("shell taps 1").assertDoesNotExist()

        dragBack(progress = 0.6f)
        compose.onNodeWithText("chat c1").assertExists()
        compose.onNodeWithText("shell taps 1").assertExists()

        pressSystemBack()
        compose.onNodeWithText("chat c1").assertExists()
        compose.onNodeWithText("shell taps 1").assertExists()
        compose.onNodeWithText("bot b1").assertDoesNotExist()
    }
}
