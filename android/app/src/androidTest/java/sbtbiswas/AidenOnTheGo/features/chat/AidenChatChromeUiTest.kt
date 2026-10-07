package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.ProgressBarRangeInfo
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
}
