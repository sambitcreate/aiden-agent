package sbtbiswas.AidenOnTheGo.features.chat

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
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenWaitingForNetworkUiTest {
    @get:Rule
    val compose = createComposeRule()

    private val timeline = AidenGenerationTimeline(
        version = 3, generationId = "stream-wait", status = AidenGenerationTimelineStatus.RUNNING,
        startedAt = 1000.0,
        steps = listOf(
            AidenAgentStep(
                "tool-1", 0, AidenAgentStep.Kind.TOOL, toolCallId = "call-1", toolName = "read_file",
                label = "Read file", status = AidenAgentStepStatus.COMPLETED, startedAt = 1000.0,
                updatedAt = 1100.0, finishedAt = 1100.0, contentOffset = 0
            )
        )
    )

    @Test
    fun workspaceChatWithChronologicalTimelineShowsWaitingAfterItsContent() {
        compose.setContent {
            AidenTheme {
                ActiveStreamingCard(
                    liveText = "Partial answer",
                    reasoning = "",
                    tools = emptyList(),
                    activityTimeline = timeline,
                    isBotChat = false,
                    palette = AidenTheme.palette,
                    isWaitingForNetwork = true
                )
            }
        }

        compose.onNodeWithText("Partial answer", substring = true).assertExists()
        compose.onNodeWithContentDescription("Aiden is waiting for the network to return").assertExists()
    }

    @Test
    fun waitingReplacesTheWorkingIndicatorBeforeAnyContent() {
        compose.setContent {
            AidenTheme {
                ActiveStreamingCard(
                    liveText = "",
                    reasoning = "",
                    tools = emptyList(),
                    activityTimeline = null,
                    isBotChat = true,
                    palette = AidenTheme.palette,
                    isWaitingForNetwork = true
                )
            }
        }

        compose.onNodeWithContentDescription("Aiden is waiting for the network to return").assertExists()
        compose.onNodeWithText("Aiden is working...").assertDoesNotExist()
    }
}
