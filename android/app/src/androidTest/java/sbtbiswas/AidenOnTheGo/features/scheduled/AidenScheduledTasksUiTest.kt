package sbtbiswas.AidenOnTheGo.features.scheduled

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasProgressBarRangeInfo
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.models.AidenScheduledTask
import sbtbiswas.AidenOnTheGo.models.AidenScheduledTaskFilter
import sbtbiswas.AidenOnTheGo.models.AidenScheduledTaskMode
import sbtbiswas.AidenOnTheGo.models.AidenScheduledTaskPermission
import java.time.Instant
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenScheduledTasksUiTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun searchFieldHasAnAccessibleSearchName() {
        compose.setContent {
            AidenTheme {
                AidenScheduleSearchField(value = "", onValueChanged = {})
            }
        }

        compose.onNodeWithContentDescription("Search scheduled tasks")
            .assertIsDisplayed()
            .assert(hasSetTextAction())
    }

    @Test
    fun statusFilterIsARadioGroupThatSelectsOncePerTap() {
        val picks = mutableListOf<AidenScheduledTaskFilter>()
        compose.setContent {
            var filter by remember { mutableStateOf(AidenScheduledTaskFilter.ALL) }
            AidenTheme {
                AidenScheduledTaskFilterRow(filter = filter, onFilterChanged = { picks += it; filter = it })
            }
        }
        val isRadio = SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton)

        compose.onNodeWithContentDescription("All scheduled tasks").assert(isRadio).assertIsSelected()
        compose.onNodeWithContentDescription("Paused scheduled tasks").assert(isRadio).assertIsNotSelected()

        compose.onNodeWithContentDescription("Paused scheduled tasks").performClick()

        compose.onNodeWithContentDescription("Paused scheduled tasks").assertIsSelected()
        compose.onNodeWithContentDescription("All scheduled tasks").assertIsNotSelected()
        compose.runOnIdle { assertEquals(listOf(AidenScheduledTaskFilter.PAUSED), picks) }
    }

    @Test
    fun savedTasksStayOnScreenWhileTheListRefreshes() {
        compose.setContent {
            AidenTheme {
                AidenScheduledTaskList(
                    tasks = listOf(task("task_1", "Morning digest")),
                    hasAnyTasks = true,
                    query = "",
                    filter = AidenScheduledTaskFilter.ALL,
                    isLoading = true,
                    isConnected = true,
                    canManage = true,
                    operationTaskId = null,
                    errorMessage = null,
                    onQueryChanged = {},
                    onFilterChanged = {},
                    onSelectTask = {},
                    onToggleEnabled = {},
                    onRetry = {}
                )
            }
        }

        compose.onNodeWithText("Morning digest").assertIsDisplayed()
        compose.onNodeWithContentDescription("Loading scheduled tasks").assertDoesNotExist()
        compose.onNode(hasProgressBarRangeInfo(ProgressBarRangeInfo.Indeterminate)).assertDoesNotExist()
    }

    @Test
    fun aFirstReadWithNothingSavedShowsPlaceholderRowsNotAnEmptyClaim() {
        compose.setContent {
            AidenTheme {
                AidenScheduledTaskList(
                    tasks = emptyList(),
                    hasAnyTasks = false,
                    query = "",
                    filter = AidenScheduledTaskFilter.ALL,
                    isLoading = true,
                    isConnected = true,
                    canManage = true,
                    operationTaskId = null,
                    errorMessage = null,
                    onQueryChanged = {},
                    onFilterChanged = {},
                    onSelectTask = {},
                    onToggleEnabled = {},
                    onRetry = {}
                )
            }
        }

        compose.onAllNodesWithContentDescription("Loading scheduled tasks").assertCountEquals(1)
        compose.onNodeWithText("No scheduled tasks").assertDoesNotExist()
        compose.onNode(hasProgressBarRangeInfo(ProgressBarRangeInfo.Indeterminate)).assertDoesNotExist()
    }

    private fun task(id: String, name: String, enabled: Boolean = true) = AidenScheduledTask(
        id = id,
        revision = "rev_$id",
        name = name,
        enabled = enabled,
        schedule = "0 9 * * *",
        timezone = "UTC",
        mode = AidenScheduledTaskMode.LLM,
        permission = AidenScheduledTaskPermission.READ_ONLY,
        prompt = "Summarize the news",
        notify = true,
        running = false,
        createdAt = Instant.parse("2026-10-01T09:00:00Z"),
        updatedAt = Instant.parse("2026-10-01T09:00:00Z")
    )
}

