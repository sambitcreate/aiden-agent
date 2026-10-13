package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.features.remote.AidenProductSwitcher
import sbtbiswas.AidenOnTheGo.models.AidenChatMessage
import sbtbiswas.AidenOnTheGo.models.AidenChatRole
import sbtbiswas.AidenOnTheGo.models.AidenGenerationTimeline
import sbtbiswas.AidenOnTheGo.models.AidenGenerationTimelineStatus
import sbtbiswas.AidenOnTheGo.persistence.AidenProductArea
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenChatChromeUiTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun jumpToLatestIsAnArrowOnlyAction() {
        compose.setContent {
            AidenTheme {
                AidenJumpToBottom(
                    visible = true,
                    onClick = {}
                )
            }
        }

        compose.onNodeWithContentDescription("Jump to latest")
            .assertIsDisplayed()
            .assertHasClickAction()
        compose.onNodeWithText("Jump to latest").assertDoesNotExist()
        compose.onNodeWithText("New tokens").assertDoesNotExist()
    }

    @Test
    fun jumpToLatestFiresOncePerTap() {
        var jumps = 0
        compose.setContent {
            AidenTheme {
                AidenJumpToBottom(visible = true, onClick = { jumps += 1 })
            }
        }

        compose.onNodeWithContentDescription("Jump to latest").performClick()
        compose.runOnIdle { assertEquals(1, jumps) }
    }

    @Test
    fun codeBlockCopyPillConfirmsThenReverts() {
        val copies = mutableListOf<String>()
        compose.mainClock.autoAdvance = false
        compose.setContent {
            AidenTheme {
                AidenCodeBlock(code = "val x = 1", language = "kotlin", palette = AidenTheme.palette, onCopy = { copies += it })
            }
        }

        compose.onNodeWithContentDescription("Copy code").assertHasClickAction().performClick()
        compose.mainClock.advanceTimeBy(500)
        compose.onNodeWithContentDescription("Copied").assertIsDisplayed()
        compose.onNodeWithContentDescription("Copy code").assertDoesNotExist()
        assertEquals(listOf("val x = 1"), copies)

        compose.mainClock.advanceTimeBy(AIDEN_CODE_COPY_CONFIRMATION_MS + 500)
        compose.onNodeWithContentDescription("Copy code").assertIsDisplayed()
        compose.onNodeWithContentDescription("Copied").assertDoesNotExist()
    }

    @Test
    fun loadEarlierMessagesFiresOnceAndIsInertWhileLoading() {
        var loads = 0
        var loading by mutableStateOf(false)
        compose.setContent {
            AidenTheme {
                AidenLoadEarlierMessages(isLoading = loading, onClick = { loads += 1 })
            }
        }

        compose.onNodeWithText("Load earlier messages").assertIsEnabled().performClick()
        compose.runOnIdle {
            assertEquals(1, loads)
            loading = true
        }
        compose.onNodeWithText("Loading earlier messages").assertIsNotEnabled()
        // Paging back is a read: it never shows a spinner.
        compose.onNode(hasProgressBarRangeInfo(ProgressBarRangeInfo.Indeterminate)).assertDoesNotExist()
    }

    @Test
    fun readAloudMiniPlayerShowsSegmentProgressAndStopsOnce() {
        var stops = 0
        compose.setContent {
            AidenTheme {
                AidenReadAloudMiniPlayer(
                    phase = AidenReadAloudPhase.PLAYING,
                    label = AidenReadAloudProgress.label(AidenReadAloudPhase.PLAYING, 4, 4, 1),
                    progressRatio = 0.375f,
                    totalSegments = 4,
                    onStop = { stops += 1 }
                )
            }
        }

        compose.onNodeWithText("Reading aloud · 2 of 4").assertIsDisplayed()
        compose.onNodeWithText("Listening...").assertDoesNotExist()
        compose.onNode(hasProgressBarRangeInfo(ProgressBarRangeInfo(0.375f, 0f..1f))).assertExists()
        compose.onNodeWithContentDescription("Stop reading aloud").performClick()
        compose.runOnIdle { assertEquals(1, stops) }
    }

    @Test
    fun productSwitcherKeepsTextOptionsAndSelectionState() {
        compose.setContent {
            AidenTheme {
                AidenProductSwitcher(
                    activeArea = AidenProductArea.BOTS,
                    onAreaSelected = {}
                )
            }
        }

        compose.onNodeWithContentDescription(
            "Aiden. Current area: Bots. Choose Bots or Workspaces."
        ).performClick()

        compose.onNodeWithText("Bots").assertIsDisplayed()
        compose.onNodeWithText("Workspaces").assertIsDisplayed()
        compose.onNodeWithContentDescription("Selected").assertIsDisplayed()
    }

    @Test
    fun completedTurnFooterShowsWorkedForAndCopiesTheResponse() {
        var copies = 0
        val message = AidenChatMessage(
            id = "a1",
            role = AidenChatRole.ASSISTANT,
            text = "Done",
            timeline = AidenGenerationTimeline(
                version = 1,
                generationId = "g1",
                status = AidenGenerationTimelineStatus.COMPLETED,
                startedAt = 1_700_000_000_000.0,
                finishedAt = 1_700_000_065_000.0,
                steps = emptyList()
            ),
            createdAt = Instant.now()
        )
        compose.setContent {
            AidenTheme {
                AidenMessageFooter(message = message, palette = AidenTheme.palette, onCopy = { copies += 1 })
            }
        }

        compose.onNodeWithTag("aiden.message.workedFor").assertTextContains("Worked for 1m 5s", substring = true)
        compose.onNodeWithContentDescription("Copy response").performClick()
        assertEquals(1, copies)
    }

    @Test
    fun messageMenuOffersAskAboutOnlyWhenTheChatIsWritable() {
        var asked = 0
        var selected = 0
        compose.setContent {
            AidenTheme {
                AidenMessageActionContainer(
                    onCopy = {},
                    onShare = {},
                    onSelectText = { selected += 1 },
                    onAskAbout = { asked += 1 }
                ) { Text("Bubble") }
            }
        }

        compose.onNodeWithText("Bubble").performTouchInput { longClick() }
        compose.onNodeWithText("Ask about this").performClick()
        assertEquals(1, asked)

        compose.onNodeWithText("Bubble").performTouchInput { longClick() }
        compose.onNodeWithText("Select Text").performClick()
        assertEquals(1, selected)
    }

    @Test
    fun readOnlyMessageMenuHidesAskAbout() {
        compose.setContent {
            AidenTheme {
                AidenMessageActionContainer(
                    onCopy = {},
                    onShare = {},
                    onSelectText = {},
                    onAskAbout = null
                ) { Text("Bubble") }
            }
        }

        compose.onNodeWithText("Bubble").performTouchInput { longClick() }
        compose.onNodeWithText("Select Text").assertIsDisplayed()
        compose.onNodeWithText("Ask about this").assertDoesNotExist()
    }

    private val liveTokens = mutableIntStateOf(3)
    private lateinit var transcript: LazyListState
    private lateinit var follow: AidenTranscriptFollowState

    private fun liveText(tokens: Int) = (1..tokens).joinToString(" ") { "token$it" }

    /** The chat screen's follow wiring around a streaming reply and older history. */
    private fun setStreamingTranscript() {
        val composerHeight = 72.dp
        compose.setContent {
            AidenTheme {
                transcript = rememberLazyListState()
                follow = rememberAidenTranscriptFollowState(transcript)
                AidenTranscriptFollowEffects(follow, itemCount = HISTORY + 1)
                val showsJump by remember(follow) { derivedStateOf { follow.showsJumpToLatest(isStreaming = true) } }
                Box(Modifier.fillMaxSize()) {
                    LazyColumn(
                        reverseLayout = true,
                        state = transcript,
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        contentPadding = PaddingValues(top = 16.dp, bottom = composerHeight + 16.dp),
                        modifier = Modifier.fillMaxSize().aidenTranscriptFollow(follow).testTag("transcript"),
                    ) {
                        item(key = "live_stream") {
                            val text = liveText(liveTokens.intValue)
                            Column {
                                Text(text, Modifier.testTag("live"))
                                Text(
                                    "val wide = listOf(" + (1..60).joinToString { "\"column$it\"" } + ")",
                                    softWrap = false,
                                    modifier = Modifier.horizontalScroll(rememberScrollState()).testTag("code"),
                                )
                            }
                            AidenStreamingFollowTrigger(follow, text.length)
                        }
                        items(HISTORY, key = { "message_$it" }) { index ->
                            Text("Earlier message $index", Modifier.height(96.dp))
                        }
                    }
                    Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(composerHeight).testTag("composer"))
                    AidenJumpToBottom(
                        visible = showsJump,
                        onClick = follow::jumpToLatest,
                        modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = composerHeight + 8.dp),
                    )
                }
            }
        }
        compose.waitForIdle()
    }

    private fun stream(ticks: Int) {
        repeat(ticks) {
            liveTokens.intValue += 7
            compose.waitForIdle()
        }
    }

    private fun viewport() = compose.runOnIdle { transcript.firstVisibleItemIndex to transcript.firstVisibleItemScrollOffset }

    @Test
    fun scrollingUpDuringAStreamKeepsTheReadersPlaceAndOffersTheJump() {
        setStreamingTranscript()
        stream(3)
        assertEquals(0 to 0, viewport())
        compose.onNodeWithContentDescription("Jump to latest").assertDoesNotExist()

        compose.onNodeWithTag("transcript").performTouchInput { swipeDown() }
        settleGesture()
        val readerPlace = viewport()
        assertNotEquals(0 to 0, readerPlace)

        stream(12)
        assertEquals(readerPlace, viewport())
        compose.runOnIdle { assertFalse(follow.isFollowing) }
        compose.onNodeWithContentDescription("Jump to latest").assertIsDisplayed()
    }

    @Test
    fun jumpingToLatestDuringAStreamPinsTheNewestTextAboveTheComposer() {
        setStreamingTranscript()
        compose.onNodeWithTag("transcript").performTouchInput { swipeDown() }
        settleGesture()
        compose.onNodeWithContentDescription("Jump to latest").performClick()
        compose.waitForIdle()

        stream(12)
        assertEquals(0 to 0, viewport())
        compose.runOnIdle { assertTrue(follow.isFollowing) }
        compose.onNodeWithText("token${liveTokens.intValue}", substring = true).assertIsDisplayed()
        val liveBottom = compose.onNodeWithTag("live").getBoundsInRoot().bottom
        val composerTop = compose.onNodeWithTag("composer").getBoundsInRoot().top
        assertTrue("live text ends at $liveBottom, composer starts at $composerTop", liveBottom <= composerTop)
        compose.onNodeWithContentDescription("Jump to latest").assertDoesNotExist()
    }

    @Test
    fun aGestureThatSettlesBackAtTheLiveEdgeResumesFollowing() {
        setStreamingTranscript()
        compose.onNodeWithTag("transcript").performTouchInput {
            // A slow drag up through history, then back to the edge before lifting.
            down(center)
            moveBy(androidx.compose.ui.geometry.Offset(0f, 300f), delayMillis = 100)
            moveBy(androidx.compose.ui.geometry.Offset(0f, -600f), delayMillis = 100)
            moveBy(androidx.compose.ui.geometry.Offset(0f, 0f), delayMillis = 200)
            up()
        }
        settleGesture()
        compose.runOnIdle { assertTrue(follow.isFollowing) }
        stream(4)
        assertEquals(0 to 0, viewport())
    }

    @Test
    fun readingInsideTheLiveReplyHoldsStillWhileItGrowsBelow() {
        liveTokens.intValue = 400
        setStreamingTranscript()
        compose.onNodeWithTag("transcript").performTouchInput {
            // A slow drag that stays inside the long live reply, released without a fling.
            down(center)
            moveBy(androidx.compose.ui.geometry.Offset(0f, 400f), delayMillis = 100)
            moveBy(androidx.compose.ui.geometry.Offset(0f, 0f), delayMillis = 200)
            up()
        }
        settleGesture()
        val (index, offset) = viewport()
        assertEquals(0, index)
        assertTrue("the reader should sit inside the live reply, offset $offset", offset > 0)
        compose.runOnIdle { assertFalse(follow.isFollowing) }
        val readingTop = compose.onNodeWithTag("live").getUnclippedBoundsInRoot().top

        stream(12)
        assertEquals(readingTop, compose.onNodeWithTag("live").getUnclippedBoundsInRoot().top)
        compose.runOnIdle { assertFalse(follow.isFollowing) }
    }

    @Test
    fun swipingSidewaysThroughACodeBlockKeepsFollowingTheStream() {
        setStreamingTranscript()
        compose.onNodeWithTag("code").performTouchInput {
            down(center)
            moveBy(androidx.compose.ui.geometry.Offset(-300f, 0f), delayMillis = 100)
        }
        compose.onNodeWithTag("code").performTouchInput { moveBy(androidx.compose.ui.geometry.Offset(-200f, 0f), delayMillis = 100) }
        // Mid-swipe, with the finger still down, the latch has not let go.
        compose.runOnIdle { assertTrue(follow.isFollowing) }
        compose.onNodeWithTag("code").performTouchInput { up() }
        settleGesture()
        stream(4)
        assertEquals(0 to 0, viewport())
    }

    /** Lets the follow latch's post-gesture settle run on the test clock instead of real time. */
    private fun settleGesture() {
        compose.mainClock.advanceTimeBy(AidenChatScroll.DRAG_SETTLE_MILLIS + AidenChatScroll.MOMENTUM_SETTLE_MILLIS)
        compose.waitForIdle()
    }

    private companion object {
        const val HISTORY = 40
    }
}
