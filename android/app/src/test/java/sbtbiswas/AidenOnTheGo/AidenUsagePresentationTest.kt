package sbtbiswas.AidenOnTheGo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.features.workspaces.AidenUsageHeatmapDay
import sbtbiswas.AidenOnTheGo.features.workspaces.AidenUsageTokenKind
import sbtbiswas.AidenOnTheGo.features.workspaces.aidenUsageDayInspectionLabel
import sbtbiswas.AidenOnTheGo.features.workspaces.aidenUsageHeatmapDays
import sbtbiswas.AidenOnTheGo.features.workspaces.aidenUsageRatio
import sbtbiswas.AidenOnTheGo.features.workspaces.aidenUsageTokenSegments
import sbtbiswas.AidenOnTheGo.features.workspaces.aidenUsageToggleSelectedDay
import sbtbiswas.AidenOnTheGo.models.*
import sbtbiswas.AidenOnTheGo.persistence.AidenUsageCache
import java.nio.file.Files
import java.util.Locale

class AidenUsagePresentationTest {
    @Test
    fun heatmapFillsMissingInclusiveDates() {
        val summary = summary(
            start = "2026-08-20",
            end = "2026-08-22",
            days = listOf(day("2026-08-21", 42))
        )

        assertEquals(
            listOf(
                "2026-08-20" to 0,
                "2026-08-21" to 42,
                "2026-08-22" to 0
            ),
            aidenUsageHeatmapDays(summary).map { it.date to it.tokens }
        )
    }

    @Test
    fun ratiosAreSafeAndClamped() {
        assertEquals(0.0, aidenUsageRatio(1, 0), 0.0)
        assertEquals(0.5, aidenUsageRatio(5, 10), 0.0)
        assertEquals(1.0, aidenUsageRatio(15, 10), 0.0)
    }

    @Test
    fun tokenBarSegmentsAreProportionalInLegendOrderAndSkipEmptyKinds() {
        val segments = aidenUsageTokenSegments(
            AidenUsageTokens(
                input = 600,
                output = 300,
                cacheRead = 100,
                cacheWrite = 5_000,
                reasoning = 0,
                total = 6_000
            )
        )

        assertEquals(
            listOf(AidenUsageTokenKind.INPUT, AidenUsageTokenKind.OUTPUT, AidenUsageTokenKind.CACHE_READ),
            segments.map { it.kind }
        )
        assertEquals(listOf(600, 300, 100), segments.map { it.tokens })
        assertEquals(0.6f, segments[0].fraction, 1e-6f)
        assertEquals(0.3f, segments[1].fraction, 1e-6f)
        assertEquals(0.1f, segments[2].fraction, 1e-6f)
    }

    @Test
    fun tokenBarHasNoSegmentsWithoutTokens() {
        assertTrue(aidenUsageTokenSegments(tokens(0)).isEmpty())
    }

    @Test
    fun tappingADaySelectsItAndTappingItAgainClearsTheInspection() {
        assertEquals("2026-10-06", aidenUsageToggleSelectedDay(null, "2026-10-06"))
        assertEquals("2026-10-07", aidenUsageToggleSelectedDay("2026-10-06", "2026-10-07"))
        assertNull(aidenUsageToggleSelectedDay("2026-10-06", "2026-10-06"))
    }

    @Test
    fun inspectionLabelNamesTheDayAndItsTokens() {
        assertEquals("Last 30 days", aidenUsageDayInspectionLabel(null, Locale.US))
        assertEquals(
            "Oct 6 · 48,210 tokens",
            aidenUsageDayInspectionLabel(AidenUsageHeatmapDay("2026-10-06", 48_210), Locale.US)
        )
        assertEquals(
            "Oct 7 · 1 token",
            aidenUsageDayInspectionLabel(AidenUsageHeatmapDay("2026-10-07", 1), Locale.US)
        )
        assertEquals(
            "someday · 0 tokens",
            aidenUsageDayInspectionLabel(AidenUsageHeatmapDay("someday", 0), Locale.US)
        )
    }

    @Test
    fun cacheIsScopedByInstallationAndRange() {
        val root = Files.createTempDirectory("aiden-usage-cache").toFile()
        val cache = AidenUsageCache(root)
        val expected = summary(days = listOf(day("2026-08-24", 7)))

        cache.store("instance-one", expected)

        assertEquals(expected, cache.load("instance-one"))
        assertNull(cache.load("instance-two"))
        assertNull(cache.load("instance-one", "7d"))
    }

    @Test
    fun cachePurgeRemovesEveryRangeOnlyForRequestedInstallation() {
        val root = Files.createTempDirectory("aiden-usage-purge").toFile()
        val cache = AidenUsageCache(root)
        val first = summary(days = listOf(day("2026-08-24", 7)))
        val second = summary(days = listOf(day("2026-08-24", 11)))
        cache.store("instance-one", first)
        cache.store("instance-two", second)

        cache.purge("instance-one")

        assertNull(cache.load("instance-one"))
        assertEquals(second, cache.load("instance-two"))
    }

    private fun summary(
        start: String = "2026-07-26",
        end: String = "2026-08-24",
        days: List<AidenUsageDay> = emptyList()
    ) = AidenUsageSummary(
        range = "30d",
        startDate = start,
        endDate = end,
        totals = AidenUsageTotals(
            requests = 0,
            completedRequests = 0,
            failedRequests = 0,
            cancelledRequests = 0,
            reportedTokenRequests = 0,
            unmeteredRequests = 0,
            localRequests = 0,
            costedRequests = 0,
            unpricedHostedRequests = 0,
            hostedCostUsd = 0.0,
            activeDays = 0,
            currentStreak = 0,
            longestStreak = 0,
            tokens = tokens(0)
        ),
        days = days,
        models = emptyList()
    )

    private fun day(date: String, total: Int) = AidenUsageDay(
        date = date,
        requests = 1,
        reportedTokenRequests = 1,
        unmeteredRequests = 0,
        tokens = tokens(total),
        hostedCostUsd = 0.0
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
