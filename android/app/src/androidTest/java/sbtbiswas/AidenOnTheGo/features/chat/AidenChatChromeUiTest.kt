package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.compose.material3.Text
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
