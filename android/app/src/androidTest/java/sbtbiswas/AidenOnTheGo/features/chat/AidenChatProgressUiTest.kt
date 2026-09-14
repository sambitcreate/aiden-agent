package sbtbiswas.AidenOnTheGo.features.chat

import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.models.AidenChatAgent
import sbtbiswas.AidenOnTheGo.models.AidenChatAgentRole
import sbtbiswas.AidenOnTheGo.models.AidenChatAgentRoster
import sbtbiswas.AidenOnTheGo.models.AidenChatAgentState
import sbtbiswas.AidenOnTheGo.models.AidenChatPreviousTurn
import sbtbiswas.AidenOnTheGo.models.AidenChatProgressAvailability
import sbtbiswas.AidenOnTheGo.models.AidenChatTask
import sbtbiswas.AidenOnTheGo.models.AidenChatTaskProgress
import sbtbiswas.AidenOnTheGo.models.AidenChatTaskStatus
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenChatProgressUiTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun currentAgentChipDoesNotUseHistoricalRosterCount() {
        val current = roster("turn_current", listOf(agent("current-agent")))
        val historical = roster(
            "turn_previous",
            listOf(agent("previous-agent-1"), agent("previous-agent-2"), agent("previous-agent-3"))
        )
        var agentClicks = 0

        compose.setContent {
            AidenTheme {
                AidenChatProgressControls(
                    taskProgress = null,
                    currentRoster = current,
                    rosterHistory = listOf(current, historical),
                    connectionState = AidenChatViewModel.ProgressConnectionState.LIVE,
                    onTasksClick = {},
                    onAgentsClick = { agentClicks++ }
                )
            }
        }

        compose.onNodeWithText("1 agent").assertExists().assertHasClickAction().performClick()
        compose.onNodeWithText("3 agents").assertDoesNotExist()
        compose.runOnIdle { assertEquals(1, agentClicks) }
    }

    @Test
    fun allCompletedAndDeletedTasksDoNotLeaveTaskChrome() {
        val progress = AidenChatTaskProgress(
            version = 1,
            chatId = "chat_progress",
            availability = AidenChatProgressAvailability.READY,
            epoch = "epoch_progress",
            revision = 2,
            updatedAt = Instant.parse("2026-08-24T00:00:00Z"),
            tasks = listOf(
                AidenChatTask(1, "Done", AidenChatTaskStatus.COMPLETED),
                AidenChatTask(2, "Removed", AidenChatTaskStatus.DELETED)
            )
        )

        compose.setContent {
            AidenTheme {
                AidenChatProgressControls(
                    taskProgress = progress,
                    currentRoster = null,
                    rosterHistory = emptyList(),
                    connectionState = AidenChatViewModel.ProgressConnectionState.IDLE,
                    onTasksClick = {},
                    onAgentsClick = {}
                )
            }
        }

        compose.onNodeWithText("1 / 1 steps").assertDoesNotExist()
        compose.onNodeWithText("Task progress").assertDoesNotExist()
    }

    @Test
    fun emptyCurrentRosterOffersEarlierAgentsFromPublicTurnMetadata() {
        val current = roster(
            "turn_current",
            agents = emptyList(),
            previousTurns = listOf(
                AidenChatPreviousTurn(
                    turnId = "turn_previous",
                    startedAt = Instant.parse("2026-08-23T00:00:00Z")
                )
            )
        )
        var agentClicks = 0

        compose.setContent {
            AidenTheme {
                AidenChatProgressControls(
                    taskProgress = null,
                    currentRoster = current,
                    rosterHistory = listOf(current),
                    connectionState = AidenChatViewModel.ProgressConnectionState.LIVE,
                    onTasksClick = {},
                    onAgentsClick = { agentClicks++ }
                )
            }
        }

        compose.onNodeWithText("Earlier agents").assertExists().performClick()
        compose.runOnIdle { assertEquals(1, agentClicks) }
    }

    @Test
    fun currentTurnAdvertisedByHistoricalRosterIsShownOnlyAsCurrent() {
        val currentTurnStartedAt = Instant.parse("2026-08-25T00:00:00Z")
        val historicalSnapshotStartedAt = Instant.parse("2026-08-24T00:00:00Z")
        val current = roster("turn_current", listOf(agent("current-agent")))
        val historical = roster(
            "turn_previous",
            listOf(agent("previous-agent")),
            previousTurns = listOf(
                AidenChatPreviousTurn(
                    turnId = "turn_current",
                    startedAt = currentTurnStartedAt
                )
            )
        )

        compose.setContent {
            AidenTheme {
                AidenAgentRosterSheet(
                    currentRoster = current,
                    selectedRoster = current,
                    history = listOf(current, historical),
                    onSelectTurn = {},
                    onAgentClick = {},
                    onDismiss = {}
                )
            }
        }

        compose.onNodeWithText("Current").assertExists()
        compose.onNodeWithText("Earlier · ${formatRosterDateForTest(currentTurnStartedAt)}").assertDoesNotExist()
        compose.onNodeWithText("Earlier · ${formatRosterDateForTest(historicalSnapshotStartedAt)}").assertExists()
    }

    private fun formatRosterDateForTest(instant: Instant): String =
        DateTimeFormatter.ofPattern("MMM d")
            .withZone(ZoneId.systemDefault())
            .format(instant)

    private fun roster(
        turnId: String,
        agents: List<AidenChatAgent>,
        previousTurns: List<AidenChatPreviousTurn> = emptyList()
    ) = AidenChatAgentRoster(
        version = 1,
        chatId = "chat_progress",
        turnId = turnId,
        previousTurns = previousTurns,
        availability = AidenChatProgressAvailability.READY,
        epoch = "epoch_progress",
        revision = 1,
        updatedAt = Instant.parse("2026-08-24T00:00:00Z"),
        agents = agents
    )

    private fun agent(id: String) = AidenChatAgent(
        agentId = id,
        depth = 1,
        revision = 1,
        role = AidenChatAgentRole.SCOUT,
        label = id,
        taskPreview = "Scout task",
        state = AidenChatAgentState.RUNNING,
        startedAt = Instant.parse("2026-08-24T00:00:00Z"),
        updatedAt = Instant.parse("2026-08-24T00:00:01Z"),
        modelId = "model",
        turns = 1,
        tools = 1,
        tokens = 1
    )
}
