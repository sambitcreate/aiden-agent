package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.models.AidenStreamState
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

/**
 * The live card hands over to the final message without a frame that shows
 * both, or neither. The writes mirror the view model: the run's terminal
 * state arrives first, the transcript is read afterwards, and publishing it
 * clears the live output in the same main-thread step.
 */
@RunWith(AndroidJUnit4::class)
class AidenLiveHandoffUiTest {
    @get:Rule
    val compose = createComposeRule()

    private val reply = "Here is the finished answer with **bold** text and a link https://example.com"
    private val streamState = MutableStateFlow<AidenStreamState?>(AidenStreamState.RUNNING)
    private val liveText = MutableStateFlow(reply)
    private val messages = MutableStateFlow(listOf("user-1" to "What changed?"))

    private fun setTranscript() {
        compose.setContent {
            AidenTheme {
                val state by streamState.collectAsState()
                val liveTextState = liveText.collectAsState()
                val transcript by messages.collectAsState()
                val hasLiveOutput by remember { derivedStateOf { liveTextState.value.isNotEmpty() } }
                val showsLiveCard = AidenChatScroll.showsLiveCard(state, hasLiveOutput)
                LazyColumn(reverseLayout = true, modifier = Modifier.fillMaxSize()) {
                    if (showsLiveCard) {
                        item(key = LIVE_STREAM_ITEM_KEY) {
                            Box(Modifier.testTag("live-card")) {
                                ActiveStreamingCard(
                                    liveText = liveTextState.value,
                                    reasoning = "",
                                    tools = emptyList(),
                                    activityTimeline = null,
                                    isBotChat = true,
                                    palette = AidenTheme.palette,
                                    onCopyMessage = {},
                                    onOpenMessageUrl = {},
                                    isActive = state?.isTerminal == false
                                )
                            }
                        }
                    }
                    items(transcript.asReversed(), key = { it.first }) { (id, text) ->
                        Box(Modifier.testTag(id)) {
                            RichFormattedMessage(text, AidenTheme.palette, onCopy = {}, onOpenUrl = {})
                        }
                    }
                }
            }
        }
    }

    private fun visible(): Pair<Boolean, Boolean> {
        val card = compose.onAllNodesWithTag("live-card").fetchSemanticsNodes().isNotEmpty()
        val final = compose.onAllNodesWithTag("final-reply").fetchSemanticsNodes().isNotEmpty()
        return card to final
    }

    private fun stepFramesRecording(frames: Int): List<Pair<Boolean, Boolean>> =
        (0 until frames).map {
            compose.mainClock.advanceTimeByFrame()
            visible()
        }

    @Test
    fun theFinalMessageReplacesTheLiveCardWithNoFrameShowingBothOrNeither() {
        setTranscript()
        compose.waitForIdle()
        assertEquals(true to false, visible())
        compose.mainClock.autoAdvance = false

        // The run ends; the transcript that holds the reply is still being read.
        compose.runOnUiThread { streamState.value = AidenStreamState.DONE }
        val settling = stepFramesRecording(10)
        assertTrue("The reply vanished before its final message arrived: $settling", settling.all { it == (true to false) })

        // Publishing the transcript clears the live output in the same step.
        compose.runOnUiThread {
            messages.value = messages.value + ("final-reply" to reply)
            liveText.value = ""
        }
        val handoff = stepFramesRecording(10)
        assertTrue("A frame showed both or neither: $handoff", handoff.none { (card, final) -> card == final })
        assertEquals(false to true, handoff.last())
    }

    @Test
    fun aRunThatEndsWithoutOutputLeavesNoEmptyCardBehind() {
        // The waiting indicator animates without end, so step frames by hand.
        compose.mainClock.autoAdvance = false
        liveText.value = ""
        setTranscript()
        stepFramesRecording(2)
        assertEquals(true to false, visible())

        compose.runOnUiThread { streamState.value = AidenStreamState.CANCELLED }
        stepFramesRecording(2)

        assertEquals(false to false, visible())
    }

    @Test
    fun aStreamingReplysCopyAndLinkActionsReachTheScreen() {
        val link = "https://example.com/docs"
        val streaming = "Run this first:\n\n```kotlin\nval answer = 42\n```\n$link"
        val bot = MutableStateFlow(true)
        val copied = ArrayList<String>()
        val opened = ArrayList<String>()
        compose.setContent {
            AidenTheme {
                // Bot chats use the plain live renderer; other chats the chronological rows.
                val isBotChat by bot.collectAsState()
                ActiveStreamingCard(
                    liveText = streaming,
                    reasoning = "",
                    tools = emptyList(),
                    activityTimeline = null,
                    isBotChat = isBotChat,
                    palette = AidenTheme.palette,
                    onCopyMessage = { copied += it },
                    onOpenMessageUrl = { opened += it },
                    isActive = true
                )
            }
        }

        for (isBotChat in listOf(true, false)) {
            compose.runOnUiThread { bot.value = isBotChat }
            compose.waitUntil(5_000) {
                compose.onAllNodesWithContentDescription("Copy code").fetchSemanticsNodes().isNotEmpty() &&
                    compose.onAllNodesWithText(link).fetchSemanticsNodes().isNotEmpty()
            }
            copied.clear()
            opened.clear()

            compose.onNodeWithContentDescription("Copy code").performClick()
            compose.onNodeWithText(link).performClick()
            compose.waitForIdle()

            assertEquals("bot chat $isBotChat", listOf("val answer = 42"), copied)
            assertEquals("bot chat $isBotChat", listOf(link), opened)
        }
    }
}
