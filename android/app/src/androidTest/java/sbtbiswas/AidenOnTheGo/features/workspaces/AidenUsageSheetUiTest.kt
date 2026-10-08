package sbtbiswas.AidenOnTheGo.features.workspaces

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollToNodeAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import sbtbiswas.AidenOnTheGo.models.AidenUsageDay
import sbtbiswas.AidenOnTheGo.models.AidenUsageSummary
import sbtbiswas.AidenOnTheGo.models.AidenUsageTokens
import sbtbiswas.AidenOnTheGo.models.AidenUsageTotals
import sbtbiswas.AidenOnTheGo.ui.theme.AidenTheme

@RunWith(AndroidJUnit4::class)
class AidenUsageSheetUiTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun tappingAHeatmapDayInspectsItAndTappingAgainRestoresTheRange() {
        compose.setContent {
            AidenTheme {
                AidenUsageSheet(summary = summary(), providers = emptyList(), onDismiss = {})
            }
        }
        val cellDescription = "2026-08-21, 42 tokens"
        compose.onNode(hasScrollToNodeAction()).performScrollToNode(hasContentDescription(cellDescription))

        val cell = compose.onNodeWithContentDescription(cellDescription)
        cell.assertIsNotSelected()
        compose.onNodeWithText("Last 30 days").assertIsDisplayed()

        cell.performClick()
        cell.assertIsSelected()
        compose.onNodeWithText("Last 30 days").assertDoesNotExist()

        cell.performClick()
        cell.assertIsNotSelected()
        compose.onNodeWithText("Last 30 days").assertIsDisplayed()
    }

    private fun summary() = AidenUsageSummary(
        range = "30d",
        startDate = "2026-08-20",
        endDate = "2026-08-22",
        totals = AidenUsageTotals(
            requests = 1,
            completedRequests = 1,
            failedRequests = 0,
            cancelledRequests = 0,
            reportedTokenRequests = 1,
            unmeteredRequests = 0,
            localRequests = 0,
            costedRequests = 0,
            unpricedHostedRequests = 0,
            hostedCostUsd = 0.0,
            activeDays = 1,
            currentStreak = 1,
            longestStreak = 1,
            tokens = tokens(42)
        ),
        days = listOf(
            AidenUsageDay(
                date = "2026-08-21",
                requests = 1,
                reportedTokenRequests = 1,
                unmeteredRequests = 0,
                tokens = tokens(42),
                hostedCostUsd = 0.0
            )
        ),
        models = emptyList()
    )

    private fun tokens(total: Int) = AidenUsageTokens(
        input = total,
        output = 0,
        cacheRead = 0,
        cacheWrite = 0,
        reasoning = 0,
        total = total
    )
}
