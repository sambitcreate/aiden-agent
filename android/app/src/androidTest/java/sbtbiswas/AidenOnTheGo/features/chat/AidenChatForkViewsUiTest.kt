package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.config.AidenAppearanceConfig
import sbtbiswas.AidenOnTheGo.models.AidenChatForkSummary
import sbtbiswas.AidenOnTheGo.models.AidenChatForkSummaryState
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenChatForkViewsUiTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun lineageChipOpensTheSourceChatOncePerTap() {
        val opened = mutableListOf<String>()
        compose.setContent {
            AidenTheme {
                AidenForkLineageRow(
                    source = AidenChatForkSource.Named("chat-source", "Parser plan"),
                    palette = AidenTheme.palette,
                    onOpenSource = { opened += it }
                )
            }
        }

        compose.onNodeWithText("Forked from Parser plan")
            .assertHasClickAction()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
            .assert(SemanticsMatcher("labels the open action") {
                it.config.getOrElseNullable(SemanticsActions.OnClick) { null }?.label == "Open the original chat"
            })
            .performClick()

        compose.runOnIdle { assertEquals(listOf("chat-source"), opened) }
    }

    @Test
    fun lineageChipForADeletedSourceIsNotTappable() {
        compose.setContent {
            AidenTheme {
                AidenForkLineageRow(
                    source = AidenChatForkSource.Deleted("chat-source"),
                    palette = AidenTheme.palette,
                    onOpenSource = { error("A deleted source must not open") }
                )
            }
        }

        compose.onNodeWithText("Forked from a deleted chat").assertHasNoClickAction()
    }

    @Test
    fun failedSummaryActionsEachFireOnce() {
        var retries = 0
        var skips = 0
        compose.setContent {
            AidenTheme {
                AidenForkSummaryCard(
                    summary = AidenChatForkSummary(
                        state = AidenChatForkSummaryState.FAILED,
                        afterMessageId = "m1",
                        error = "The provider timed out."
                    ),
                    palette = AidenTheme.palette,
                    busy = false,
                    canManage = true,
                    onCancel = {},
                    onRetry = { retries++ },
                    onSkip = { skips++ }
                )
            }
        }

        compose.onNodeWithText("Retry").performClick()
        compose.onNodeWithText("Continue without summary").performClick()
        compose.runOnIdle {
            assertEquals(1, retries)
            assertEquals(1, skips)
        }
    }

    @Test
    fun readySummaryAccordionRevealsTheSummaryWithReducedMotion() {
        compose.setContent {
            AidenTheme(config = AidenAppearanceConfig(reduceMotion = true)) {
                AidenForkSummaryCard(
                    summary = AidenChatForkSummary(
                        state = AidenChatForkSummaryState.READY,
                        afterMessageId = "m1",
                        focus = "the parser",
                        text = "The parser now streams tokens."
                    ),
                    palette = AidenTheme.palette,
                    busy = false,
                    canManage = true,
                    onCancel = {},
                    onRetry = {},
                    onSkip = {}
                )
            }
        }

        val header = compose.onNodeWithText("What happened after this point")
        header.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Collapsed"))
        compose.onNodeWithText("The parser now streams tokens.").assertDoesNotExist()

        compose.mainClock.autoAdvance = false
        header.performClick()
        // Reduced motion snaps the accordion open on the very next frame.
        compose.mainClock.advanceTimeByFrame()
        compose.onNodeWithText("The parser now streams tokens.").assertExists()
        compose.onNodeWithText("Focus: the parser").assertExists()
        header.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Expanded"))
        compose.mainClock.autoAdvance = true
    }
}
