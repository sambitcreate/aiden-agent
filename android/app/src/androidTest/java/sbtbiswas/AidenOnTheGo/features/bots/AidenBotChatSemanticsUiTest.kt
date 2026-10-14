package sbtbiswas.AidenOnTheGo.features.bots

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.models.AidenBotSession
import sbtbiswas.AidenOnTheGo.models.AidenBotSessionActivity
import sbtbiswas.AidenOnTheGo.models.AidenBotSessionState
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

/** What TalkBack hears from the Bot chat's status line and its unsent messages. */
@RunWith(AndroidJUnit4::class)
class AidenBotChatSemanticsUiTest {
    @get:Rule
    val compose = createComposeRule()

    private fun running(startedAt: Long) = AidenBotSession(
        botId = "bot_fixture_01",
        epoch = "epoch_1",
        seq = 1,
        state = AidenBotSessionState.RUNNING,
        interrupted = false,
        entries = emptyList(),
        hasOlder = false,
        question = null,
        approval = null,
        activity = AidenBotSessionActivity("reading", null, startedAt)
    )

    // FR-m8: the word is the line's name and the elapsed time its state, as on iOS.
    @Test
    fun theStatusLineIsNamedByItsWordWithTheElapsedTimeAsItsState() {
        val ui = AidenBotSessionUiState(session = running(System.currentTimeMillis() - 75_000), activitySupported = true, hasLoaded = true)
        // The mark and the elapsed clock tick forever: hold the clock so the test can settle.
        compose.mainClock.autoAdvance = false
        compose.setContent { AidenTheme { AidenBotStatusLine(ui) } }
        compose.mainClock.advanceTimeBy(1_000)
        val node = compose.onNodeWithTag(AidenBotStatusLineTags.LINE).fetchSemanticsNode()
        assertEquals(listOf("Reading"), node.config.getOrNull(SemanticsProperties.ContentDescription))
        val state = node.config.getOrNull(SemanticsProperties.StateDescription)
        assertTrue("elapsed state was $state", state != null && Regex("^1m 1[5-7]s$").matches(state))
    }

    @Test
    fun underTwentySecondsTheLineHasNoElapsedState() {
        val ui = AidenBotSessionUiState(session = running(System.currentTimeMillis() - 5_000), activitySupported = true, hasLoaded = true)
        // The mark and the elapsed clock tick forever: hold the clock so the test can settle.
        compose.mainClock.autoAdvance = false
        compose.setContent { AidenTheme { AidenBotStatusLine(ui) } }
        compose.mainClock.advanceTimeBy(1_000)
        compose.onNodeWithTag(AidenBotStatusLineTags.LINE)
            .assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.StateDescription))
    }

    // A failed message says so as its state, and Try again is its own control.
    @Test
    fun aFailedMessageCarriesItsStateAndOffersTryAgain() {
        val message = AidenBotOutgoingMessage.create("Plan lunch", null, enqueuedWhileRunning = false, retryOf = null, nowMs = 0)
            .copy(status = AidenBotOutgoingStatus.FAILED)
        var retried = 0
        compose.setContent {
            AidenTheme {
                AidenBotOutgoingBubble(message, AidenBotOutgoingLook.Failed, canRetry = true, onRetry = { retried += 1 }, onRemove = {})
            }
        }
        compose.onNodeWithText("Plan lunch", useUnmergedTree = false)
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Couldn’t send"))
        compose.onNodeWithText("Try again").assertHasClickAction().performClick()
        compose.runOnIdle { assertEquals(1, retried) }
    }
}
