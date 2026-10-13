package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.models.AidenAgentStep
import sbtbiswas.AidenOnTheGo.models.AidenAgentStepStatus
import sbtbiswas.AidenOnTheGo.models.AidenGenerationTimeline
import sbtbiswas.AidenOnTheGo.models.AidenGenerationTimelineStatus
import sbtbiswas.AidenOnTheGo.models.AidenLiveTool
import sbtbiswas.AidenOnTheGo.models.AidenQuestionnaireRecap
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenQuestionnaireRecapUiTest {
    @get:Rule
    val compose = createComposeRule()

    private fun item(question: String, kind: AidenQuestionnaireRecap.ItemKind, vararg answers: String) =
        AidenQuestionnaireRecap.Item(question, "Header", kind, answers.toList())

    private val answered = AidenQuestionnaireRecap(
        version = 1,
        outcome = AidenQuestionnaireRecap.Outcome.ANSWERED,
        items = listOf(
            item("Which database?", AidenQuestionnaireRecap.ItemKind.OPTION, "Postgres"),
            item("Which extras?", AidenQuestionnaireRecap.ItemKind.MULTI, "Auth", "Billing"),
            item("Anything else?", AidenQuestionnaireRecap.ItemKind.CUSTOM, "Keep it small"),
            item("Deploy target?", AidenQuestionnaireRecap.ItemKind.SKIPPED)
        )
    )

    @Test
    fun answeredRecapShowsEachQuestionWithItsAnswer() {
        compose.setContent {
            AidenTheme { AidenQuestionnaireRecapStack(recap = answered, palette = AidenTheme.palette) }
        }

        compose.onNodeWithContentDescription("Your answers").assertExists()
        compose.onNodeWithText("Which database?").assertIsDisplayed()
        compose.onNodeWithText("Postgres").assertIsDisplayed()
        compose.onNodeWithText("Auth, Billing").assertIsDisplayed()
        compose.onNodeWithText("“Keep it small”").assertIsDisplayed()
        compose.onNodeWithText("Skipped").assertIsDisplayed()
    }

    @Test
    fun unansweredItemsSayWhyTheyHaveNoAnswer() {
        val skipped = listOf(item("Which database?", AidenQuestionnaireRecap.ItemKind.SKIPPED))
        compose.setContent {
            AidenTheme {
                androidx.compose.foundation.layout.Column {
                    AidenQuestionnaireRecapStack(
                        recap = AidenQuestionnaireRecap(1, AidenQuestionnaireRecap.Outcome.DISMISSED, skipped),
                        palette = AidenTheme.palette
                    )
                    AidenQuestionnaireRecapStack(
                        recap = AidenQuestionnaireRecap(1, AidenQuestionnaireRecap.Outcome.EXPIRED, skipped),
                        palette = AidenTheme.palette
                    )
                }
            }
        }

        compose.onNodeWithText("Dismissed").assertIsDisplayed()
        compose.onNodeWithText("No answer").assertIsDisplayed()
        compose.onNodeWithText("Skipped").assertDoesNotExist()
    }

    @Test
    fun transcriptShowsTheRecapInPlaceOfTheQuestionActivityLine() {
        val timeline = AidenGenerationTimeline(
            version = 3, generationId = "stream-questions", status = AidenGenerationTimelineStatus.RUNNING,
            startedAt = 1000.0,
            steps = listOf(
                AidenAgentStep(
                    "tool-1", 0, AidenAgentStep.Kind.TOOL, toolCallId = "call-1", toolName = "ask_user_question",
                    label = "Ask questions", status = AidenAgentStepStatus.COMPLETED, startedAt = 1000.0,
                    updatedAt = 1100.0, finishedAt = 1100.0, contentOffset = 7, questionnaire = answered
                )
            )
        )
        compose.setContent {
            AidenTheme {
                ActiveStreamingCard(
                    liveText = "Before.After",
                    reasoning = "",
                    tools = emptyList(),
                    activityTimeline = timeline,
                    isBotChat = false,
                    palette = AidenTheme.palette
                )
            }
        }

        compose.onNodeWithText("Before.").assertExists()
        compose.onNodeWithText("Postgres").assertExists()
        compose.onNodeWithText("After", substring = true).assertExists()
        compose.onNodeWithText("Ask questions").assertDoesNotExist()
    }

    @Test
    fun liveFallbackShowsTheRecapAndTheTimelineCallsInsteadOfThePlainQuestionRow() {
        val timeline = AidenGenerationTimeline(
            version = 3, generationId = "stream-fallback", status = AidenGenerationTimelineStatus.RUNNING,
            startedAt = 1000.0,
            steps = listOf(
                AidenAgentStep(
                    "tool-1", 0, AidenAgentStep.Kind.TOOL, toolCallId = "call-1", toolName = "read_file",
                    label = "Read file", status = AidenAgentStepStatus.COMPLETED, startedAt = 1000.0,
                    updatedAt = 1050.0, finishedAt = 1050.0, contentOffset = 40
                ),
                AidenAgentStep(
                    "tool-2", 1, AidenAgentStep.Kind.TOOL, toolCallId = "call-2", toolName = "ask_user_question",
                    label = "Ask questions", status = AidenAgentStepStatus.COMPLETED, startedAt = 1050.0,
                    updatedAt = 1100.0, finishedAt = 1100.0, contentOffset = 40, questionnaire = answered
                )
            )
        )
        compose.setContent {
            AidenTheme {
                // The text has not reached the steps' offset, so there are no chronological rows.
                ActiveStreamingCard(
                    liveText = "Before.",
                    reasoning = "",
                    tools = listOf(
                        AidenLiveTool("tool_1", "read_file", "completed"),
                        AidenLiveTool("tool_2", "ask_user_question", "completed")
                    ),
                    activityTimeline = timeline,
                    isBotChat = false,
                    palette = AidenTheme.palette
                )
            }
        }

        compose.onNodeWithContentDescription("Your answers").assertExists()
        compose.onNodeWithText("Postgres").assertIsDisplayed()
        compose.onNodeWithText("Auth, Billing").assertIsDisplayed()
        compose.onNodeWithText("ask_user_question").assertDoesNotExist()
        compose.onNodeWithText("read_file").assertDoesNotExist()
        compose.onNodeWithText("Read", substring = true).assertExists()
    }
}
