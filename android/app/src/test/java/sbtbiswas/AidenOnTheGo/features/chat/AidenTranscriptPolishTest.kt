package sbtbiswas.AidenOnTheGo.features.chat

import java.time.Instant
import java.time.ZoneOffset
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sbtbiswas.AidenOnTheGo.models.AidenChatMessage
import sbtbiswas.AidenOnTheGo.models.AidenChatRole
import sbtbiswas.AidenOnTheGo.models.AidenGenerationTimeline
import sbtbiswas.AidenOnTheGo.models.AidenGenerationTimelineStatus

class AidenTranscriptPolishTest {
    private val base = Instant.parse("2026-03-04T15:45:00Z")

    private fun timeline(
        status: AidenGenerationTimelineStatus,
        startedAt: Double,
        finishedAt: Double?
    ) = AidenGenerationTimeline(
        version = 1,
        generationId = "gen-1",
        status = status,
        startedAt = startedAt,
        finishedAt = finishedAt,
        steps = emptyList()
    )

    private fun message(
        role: AidenChatRole,
        timeline: AidenGenerationTimeline? = null,
        createdAt: Instant = base,
        text: String = "Hello"
    ) = AidenChatMessage(id = "m-${createdAt.toEpochMilli()}-$role", role = role, text = text, timeline = timeline, createdAt = createdAt)

    @Test
    fun workedForUsesTheMacTimelineOnlyForCompletedAssistantTurns() {
        val start = 1_700_000_000_000.0
        assertEquals(
            "Worked for 1m 5s",
            AidenTurnElapsed.workedForLabel(message(AidenChatRole.ASSISTANT, timeline(AidenGenerationTimelineStatus.COMPLETED, start, start + 65_400)))
        )
        assertEquals(
            "Worked for 42s",
            AidenTurnElapsed.workedForLabel(message(AidenChatRole.ASSISTANT, timeline(AidenGenerationTimelineStatus.COMPLETED, start, start + 42_000)))
        )
        assertEquals(
            "Worked for 1h 3m",
            AidenTurnElapsed.workedForLabel(message(AidenChatRole.ASSISTANT, timeline(AidenGenerationTimelineStatus.COMPLETED, start, start + 3_795_000)))
        )
        // Failed/cancelled turns, missing finish, clock skew, user rows, and legacy rows carry no duration.
        assertNull(AidenTurnElapsed.workedForLabel(message(AidenChatRole.ASSISTANT, timeline(AidenGenerationTimelineStatus.FAILED, start, start + 5_000))))
        assertNull(AidenTurnElapsed.workedForLabel(message(AidenChatRole.ASSISTANT, timeline(AidenGenerationTimelineStatus.COMPLETED, start, null))))
        assertNull(AidenTurnElapsed.workedForLabel(message(AidenChatRole.ASSISTANT, timeline(AidenGenerationTimelineStatus.COMPLETED, start, start - 1))))
        assertNull(AidenTurnElapsed.workedForLabel(message(AidenChatRole.USER, timeline(AidenGenerationTimelineStatus.COMPLETED, start, start + 5_000))))
        assertNull(AidenTurnElapsed.workedForLabel(message(AidenChatRole.ASSISTANT)))
    }

    @Test
    fun liveWorkingTimerStartsAtTheTimelineOrTheTurnsUserMessage() {
        val older = message(AidenChatRole.USER, createdAt = base.minusSeconds(600))
        val reply = message(AidenChatRole.ASSISTANT, createdAt = base.minusSeconds(590))
        val latest = message(AidenChatRole.USER, createdAt = base)
        val messages = listOf(older, reply, latest)

        val running = timeline(AidenGenerationTimelineStatus.RUNNING, base.plusSeconds(2).toEpochMilli().toDouble(), null)
        assertEquals(base.plusSeconds(2), AidenTurnElapsed.liveStart(running, messages))
        assertEquals(base, AidenTurnElapsed.liveStart(null, messages))
        assertNull(AidenTurnElapsed.liveStart(null, emptyList()))

        assertEquals("Working for 1m 30s", AidenTurnElapsed.workingLabel(base, base.plusSeconds(90)))
        assertEquals("Working for 0s", AidenTurnElapsed.workingLabel(base, base.minusSeconds(3)))
    }

    @Test
    fun messageTimestampShowsTimeTodayThenYesterdayThenDate() {
        val now = Instant.parse("2026-03-04T18:00:00Z")
        val today = AidenMessageTimestamp.label(base, now, ZoneOffset.UTC, Locale.US)
        assertTrue(today, today.contains("3:45"))
        assertFalse(today, today.contains("Yesterday") || today.contains("Mar"))

        val yesterday = AidenMessageTimestamp.label(base.minusSeconds(86_400), now, ZoneOffset.UTC, Locale.US)
        assertTrue(yesterday, yesterday.startsWith("Yesterday ") && yesterday.contains("3:45"))

        val sameYear = AidenMessageTimestamp.label(Instant.parse("2026-01-15T09:05:00Z"), now, ZoneOffset.UTC, Locale.US)
        assertTrue(sameYear, sameYear.startsWith("Jan 15, ") && sameYear.contains("9:05") && !sameYear.contains("2026"))

        val otherYear = AidenMessageTimestamp.label(Instant.parse("2025-12-31T09:05:00Z"), now, ZoneOffset.UTC, Locale.US)
        assertTrue(otherYear, otherYear.startsWith("Dec 31, 2025, ") && otherYear.contains("9:05"))

        // Near midnight, the calendar day in the viewer's zone decides "today", not the UTC day.
        val lateUtc = Instant.parse("2026-03-05T02:00:00Z")
        val eastern = java.time.ZoneId.of("America/New_York")
        val afterLocalMidnight = Instant.parse("2026-03-05T06:00:00Z")
        assertTrue(AidenMessageTimestamp.label(lateUtc, afterLocalMidnight, eastern, Locale.US).startsWith("Yesterday "))
        assertFalse(AidenMessageTimestamp.label(lateUtc, afterLocalMidnight, ZoneOffset.UTC, Locale.US).contains("Yesterday"))
    }

    @Test
    fun askAboutQuotesSelectionAfterTheExistingDraft() {
        assertEquals("> Use a mutex\n\n", AidenSelectionQuote.draft("  Use a mutex \n", ""))
        assertEquals(
            "Thanks.\n\n> line one\n>\n> line three\n\n",
            AidenSelectionQuote.draft("line one\n\nline three", "Thanks.  \n")
        )
        assertNull(AidenSelectionQuote.draft(" \n\t ", "keep me"))

        val long = "x".repeat(AidenSelectionQuote.MAXIMUM_QUOTED_CHARACTERS + 50)
        val quoted = AidenSelectionQuote.draft(long, "")!!
        assertEquals("> " + "x".repeat(AidenSelectionQuote.MAXIMUM_QUOTED_CHARACTERS) + "…\n\n", quoted)
    }
}
